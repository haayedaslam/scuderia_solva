/**
 * Request generator: produces realistic, varied race-weekend compute requests for McLaren Racing
 * at the 2026 Las Vegas Grand Prix.
 *
 * Each template is a real piece of F1 race-weekend engineering (aero CFD, strategy simulation,
 * tyre modelling, telemetry, setup sweeps, driver-in-the-loop prep, reliability, parts sign-off
 * before the factory builds them, fan-app media), with its own ranges for:
 *   - size (GPU-hours)
 *   - deadline flexibility (hours the job may wait for a cleaner grid; 0 = the pit wall needs it now)
 *   - placement: any region (spread by CO2e), or pinned to the trackside hub for latency or because
 *     the car's telemetry stays at the track
 *
 * These parameters decide how SolvaGreen treats each job: flexible overnight work moves to the
 * cleanest grid automatically; live session work pinned trackside often needs a carbon approval;
 * big sign-off runs may hit SolvaPay's per-call limit or the green-premium limit.
 *
 * Randomness is seeded, so the same seed always generates the same requests (repeatable demos and tests).
 * Cars are "Lando's car", "the sister car" or "both cars".
 */

import type { JobSpec, Process, Scenario } from './scenarios.ts';

interface Vocabulary {
  region: string;
  /** Where the race is, for names. */
  track: string;
  /** The cloud region nearest the circuit: latency-critical and telemetry-bound work runs here. */
  trackside: { zone: string; why: string };
  /** Sessions already run by the demo clock (Saturday 08:00): their data can be analysed. */
  sessions: string[];
  /** Sessions still to come: they can be prepared and strategised for. */
  upcoming: string[];
  components: string[];
  parts: string[];
  setups: string[];
  /** How cars are referred to (the user is Lando Norris' race engineer). */
  cars: string[];
}

const VOCAB: Record<Scenario['key'], Vocabulary> = {
  lv: {
    region: 'US',
    track: 'Las Vegas',
    trackside: { zone: 'NEVP', why: 'trackside hub in Las Vegas, telemetry stays in Nevada' },
    // Demo clock is Friday 08:00: Thursday's FP1 + FP2 are done; FP3, qualifying and Saturday night's race are ahead.
    sessions: ['FP1', 'FP2'],
    upcoming: ['FP3', 'Q1', 'Q2', 'Q3', 'Saturday night’s race'],
    components: ['low-drag rear wing', 'beam wing', 'front-wing flap', 'floor edge', 'brake-duct winglet', 'rear-wing endplate'],
    parts: ['front wing', 'floor', 'rear-wing endplate', 'brake duct', 'suspension wishbone', 'nose cone'],
    setups: ['ride-height sweep', 'rear-wing level sweep', 'differential map sweep', 'brake-cooling sweep'],
    cars: ['Lando’s car', 'the sister car'],
  },
};

/** 'any' = spread by CO2e · 'trackside' = pinned to the track's region · 'either' = 50/50 */
type Placement = 'any' | 'trackside' | 'either';

interface Template {
  process: Process;
  /** Relative frequency. */
  weight: number;
  gpuh: [number, number];
  flex: [number, number];
  placement: Placement;
  build(c: Ctx): { name: string; detail: string; prompt: string };
}

interface Ctx { v: Vocabulary; pick: <T>(xs: T[]) => T }

const TEMPLATES: Template[] = [
  { process: 'Aero', weight: 2, gpuh: [40, 120], flex: [12, 24], placement: 'any', build: c => {
      const part = c.pick(c.v.components);
      return { name: `Overnight CFD on the ${c.v.track} ${part}`, detail: 'results needed before the next session', prompt: `Run the overnight CFD sweep on the ${part} package for ${c.v.track} and post the deltas to the aero channel.` };
    } },
  { process: 'Aero', weight: 1, gpuh: [20, 50], flex: [12, 24], placement: 'any', build: c => {
      const part = c.pick(c.v.components);
      return { name: `Correlate wind-tunnel and CFD data for the ${part}`, detail: 'closes the loop on Friday’s upgrade', prompt: `Correlate the latest wind-tunnel runs with CFD for the ${part} and report the correlation gap.` };
    } },
  { process: 'Parts', weight: 2, gpuh: [16, 60], flex: [6, 24], placement: 'any', build: c => {
      const part = c.pick(c.v.parts);
      return { name: `Order replacement ${part} from factory`, detail: 'structural + CFD sign-off before the factory builds it', prompt: `Order a replacement ${part} from the factory: run the structural and CFD sign-off on the design, then release it to manufacturing.` };
    } },
  { process: 'Parts', weight: 1, gpuh: [20, 48], flex: [8, 24], placement: 'any', build: c => {
      const part = c.pick(c.v.parts);
      return { name: `Validate lightweight ${part} before air-freight`, detail: 'fatigue + stiffness checks on the new layup', prompt: `Validate the lightweight ${part} layup for fatigue and stiffness before it is air-freighted to the track.` };
    } },
  { process: 'Strategy', weight: 3, gpuh: [3, 8], flex: [0, 0], placement: 'trackside', build: c => {
      const s = c.pick(c.v.upcoming);
      return { name: `Finalise strategy for ${s}`, detail: 'live, the pit wall needs it now', prompt: `Finalise the plan for ${s}: tyre choice, out-lap timing and traffic gaps for both cars.` };
    } },
  { process: 'Strategy', weight: 2, gpuh: [10, 30], flex: [4, 12], placement: 'any', build: c => {
      const s = c.pick(c.v.upcoming);
      return { name: `Monte Carlo strategy sims for ${s}`, detail: 'one- vs two-stop, safety-car windows', prompt: `Run Monte Carlo strategy simulations for ${s} covering one- and two-stop plans and safety-car windows.` };
    } },
  { process: 'Tyres', weight: 2, gpuh: [6, 14], flex: [2, 10], placement: 'trackside', build: c => {
      const s = c.pick(c.v.sessions);
      return { name: `Tyre warm-up + degradation model after ${s}`, detail: 'cold night track: warm-up and graining', prompt: `Refit the tyre warm-up and graining model on ${s} long-run data for both cars.` };
    } },
  { process: 'Telemetry', weight: 2, gpuh: [4, 12], flex: [1, 8], placement: 'trackside', build: c => {
      const s = c.pick(c.v.sessions);
      return { name: `Crunch ${s} telemetry for both cars`, detail: 'braking stability + ride-height anomalies', prompt: `Process ${s} telemetry for both cars and flag braking-stability and ride-height anomalies.` };
    } },
  { process: 'Vehicle dynamics', weight: 2, gpuh: [12, 36], flex: [4, 12], placement: 'either', build: c => {
      const setup = c.pick(c.v.setups), s = c.pick(c.v.upcoming);
      return { name: `Setup ${setup} for ${s}`, detail: 'vehicle-model sweep on both cars', prompt: `Run a ${setup} on the vehicle model for ${s} for both cars and rank the options.` };
    } },
  { process: 'Driver sim', weight: 1, gpuh: [8, 20], flex: [2, 10], placement: 'any', build: c => {
      const car = c.pick(c.v.cars), s = c.pick(c.v.upcoming);
      return { name: `Driver-in-the-loop sim prep for ${car} before ${s}`, detail: 'track model + tyre model update for the simulator', prompt: `Prepare the driver-in-the-loop simulator for ${car} before ${s}: update the track and tyre models.` };
    } },
  { process: 'Reliability', weight: 1, gpuh: [6, 16], flex: [6, 24], placement: 'any', build: c => {
      const unit = c.pick(['gearbox', 'power-unit', 'brake-disc', 'hydraulics']), car = c.pick(c.v.cars);
      return { name: `${unit[0].toUpperCase() + unit.slice(1)} life model update for ${car}`, detail: 'mileage + temperature history', prompt: `Update the ${unit} life model for ${car} with this weekend's mileage and temperature history.` };
    } },
  { process: 'Media', weight: 1, gpuh: [4, 12], flex: [2, 12], placement: 'any', build: c => {
      const s = c.pick(c.v.sessions);
      return { name: `Render ${s} onboard highlights for the fan app`, detail: 'batch video render + captions', prompt: `Render ${s} onboard highlights for both cars for the fan app, with captions.` };
    } },
];

/** Small, fast, seedable PRNG (mulberry32). Same seed → same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates `count` new requests for the scenario. IDs continue after the highest in `existing`
 * (J6, J7, …). Every generated job uses only zones the scenario has, and never repeats a request
 * already in the queue.
 */
export function generateJobs(scenario: Scenario, existing: JobSpec[], count: number, random: () => number): JobSpec[] {
  const v = VOCAB[scenario.key];
  const allZones = Object.keys(scenario.zones);
  const int = (a: number, b: number) => a + Math.floor(random() * (b - a + 1));
  const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
  const totalWeight = TEMPLATES.reduce((s, t) => s + t.weight, 0);
  const pickTemplate = () => {
    let r = random() * totalWeight;
    for (const t of TEMPLATES) if ((r -= t.weight) < 0) return t;
    return TEMPLATES[0];
  };

  let next = Math.max(0, ...existing.map(j => Number(j.id.slice(1)) || 0)) + 1;
  const used = new Set(existing.map(j => j.name));
  const out: JobSpec[] = [];
  for (let i = 0; i < count; i++) {
    // Draw until the name is new (a few tries; templates × options give plenty of combinations).
    let t: Template, gpuh: number, flex: number, pinned: boolean, built: ReturnType<Template['build']>;
    let tries = 0;
    do {
      t = pickTemplate();
      gpuh = Math.round(int(t.gpuh[0], t.gpuh[1]) / 2) * 2 || t.gpuh[0]; // even numbers read cleaner
      flex = int(t.flex[0], t.flex[1]);
      pinned = t.placement === 'trackside' || (t.placement === 'either' && random() < 0.5);
      built = t.build({ v, pick });
    } while (used.has(built.name) && ++tries < 12);
    used.add(built.name);

    const where = pinned ? v.trackside.why : `any ${v.region} grid · placed wherever CO₂e is lowest`;
    const when = flex === 0 ? 'must run now' : `within ${flex} h`;
    out.push({
      id: `J${next++}`,
      name: built.name,
      process: t.process,
      gpuh,
      flex,
      zones: pinned ? [v.trackside.zone] : allZones,
      note: `${gpuh} GPU-h · ${where} · ${when} · ${built.detail}`,
      prompt: built.prompt,
    });
  }
  return out;
}
