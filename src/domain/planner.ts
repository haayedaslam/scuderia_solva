/**
 * The carbon gate: SolvaGreen's own decision logic. Pure functions, no I/O, easy to test.
 *
 * Given a job and a carbon forecast for each allowed zone, it lists every (zone, hour) slot the
 * job could run in and picks one in this order of preference:
 *
 *   1. under the owner's carbon cap AND within the remaining green-premium limit → lowest emissions
 *   2. under the carbon cap but every such slot is over the premium limit → the cheapest of those,
 *      flagged so the owner decides whether to pay the extra (premiumGate: 'needs_approval')
 *   3. nothing under the carbon cap → the cleanest slot, flagged for the owner (carbonGate: 'needs_approval')
 *
 * "Premium" = what a slot costs on top of the budget-only choice (cheapest zone, right now),
 * including the ECTs SolvaGreen will auto-buy to offset what the slot still emits.
 *
 * What this deliberately does NOT do: check the budget. SolvaPay owns the spend policy
 * (per-call, per-day, per-month limits and approvals) and enforces it at authorize time.
 * Copying those limits here would give two sources of truth that drift apart.
 */

import type { HourlyForecast } from '../carbon/provider.ts';
import type { JobSpec, Zone } from './scenarios.ts';

/** Energy per GPU-hour: ~700 W per GPU × 1.2 data-centre overhead (PUE). An assumption. */
export const KWH_PER_GPU_HOUR = 0.7 * 1.2;

/** One ECT (Emission Carbon Token) offsets 1 kgCO2e. Purchases round up to whole tokens. */
export const ectTokensFor = (kg: number) => Math.ceil(kg - 1e-9);

export interface Slot {
  zone: string;
  /** Hours from now the job would start (0 = immediately). */
  offset: number;
  /** Hour of day, for labels. */
  hour: number;
  intensity: number; // g/kWh
  kwh: number;
  kg: number; // kgCO2e
  price: number; // USD for the GPU time
  /** ECTs needed to offset this slot's emissions. */
  ectTokens: number;
  /** USD on top of the budget-only choice: extra GPU cost + ECT cost. Set by plan(). */
  premium: number;
}

export interface PlanOptions {
  /** Only consider slots at or under this GPU price (the agent's own hint). */
  maxPrice?: number;
  /** How much green premium is left today. Omit for no limit. */
  premiumRemaining?: number;
  /** USD per ECT; 0 when auto-buy is off. */
  ectPrice?: number;
}

export interface Plan {
  /** What an agent that only looks at price would do: cheapest zone, start now. */
  baseline: Slot;
  /** The slot SolvaGreen recommends. */
  pick: Slot;
  /** 'pass' = under the cap. 'needs_approval' = nothing under the cap, so the owner must decide. */
  carbonGate: 'pass' | 'needs_approval';
  /** 'pass' = within the green-premium limit. 'needs_approval' = every clean slot costs more than is left. */
  premiumGate: 'pass' | 'needs_approval';
  /** The cleanest slot, when the premium limit made us pick a different one (for the log). */
  cleanestOverLimit?: Slot;
  /** How many slots were compared. */
  considered: number;
  cap: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function listSlots(job: Pick<JobSpec, 'gpuh' | 'flex' | 'zones'>, forecasts: Map<string, HourlyForecast>, zones: Record<string, Zone>): Slot[] {
  const kwh = job.gpuh * KWH_PER_GPU_HOUR;
  const slots: Slot[] = [];
  for (const zone of job.zones) {
    const f = forecasts.get(zone);
    if (!f) continue;
    for (let offset = 0; offset <= job.flex && offset < f.values.length; offset++) {
      const intensity = f.values[offset];
      const kg = (kwh * intensity) / 1000;
      const price = round2(job.gpuh * zones[zone].price); // whole cents
      slots.push({ zone, offset, hour: f.startHour + offset, intensity, kwh, kg, price, ectTokens: ectTokensFor(kg), premium: 0 });
    }
  }
  return slots;
}

export function plan(
  job: Pick<JobSpec, 'gpuh' | 'flex' | 'zones'>,
  forecasts: Map<string, HourlyForecast>,
  zones: Record<string, Zone>,
  cap: number,
  opts: PlanOptions = {},
): Plan {
  const raw = listSlots(job, forecasts, zones);
  if (!raw.length) throw new Error('No forecast available for any allowed zone');

  // The budget-only choice is the reference point: premium 0 by definition.
  const baselineRaw = raw.filter(s => s.offset === 0).sort((a, b) => a.price - b.price)[0];
  const ectPrice = opts.ectPrice ?? 0;
  const slots = raw.map(s => ({ ...s, premium: round2(s.price - baselineRaw.price + s.ectTokens * ectPrice) }));
  const baseline = { ...baselineRaw, premium: 0 };

  const affordable = opts.maxPrice == null ? slots : slots.filter(s => s.price <= opts.maxPrice!);
  const pool = affordable.length ? affordable : slots;

  // Lowest emissions first; price breaks ties.
  const byKg = (a: Slot, b: Slot) => a.kg - b.kg || a.price - b.price;
  const clean = pool.filter(s => s.intensity <= cap).sort(byKg);
  const base = { baseline, considered: slots.length, cap };

  if (!clean.length) {
    return { ...base, pick: [...pool].sort(byKg)[0], carbonGate: 'needs_approval', premiumGate: 'pass' };
  }
  const remaining = opts.premiumRemaining ?? Infinity;
  const withinLimit = clean.filter(s => s.premium <= remaining + 1e-9);
  if (withinLimit.length) {
    const pick = withinLimit[0];
    return { ...base, pick, carbonGate: 'pass', premiumGate: 'pass', cleanestOverLimit: pick === clean[0] ? undefined : clean[0] };
  }
  // Every clean slot is over the premium limit: offer the cheapest clean one for the owner to decide.
  const cheapestClean = [...clean].sort((a, b) => a.premium - b.premium || a.kg - b.kg)[0];
  return { ...base, pick: cheapestClean, carbonGate: 'pass', premiumGate: 'needs_approval' };
}
