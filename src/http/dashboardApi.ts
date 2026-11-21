/**
 * The owner-facing API that the dashboard pages (public/*.html) use.
 *
 *   GET  /api/state            everything the dashboard draws, in one snapshot
 *   GET  /api/events           live updates (Server-Sent Events)
 *   POST /api/approvals/:id    the owner's decision: { decision: 'approve' | 'decline' | 'raise' }
 *   PUT  /api/policy           { carbonCap, greenPremiumLimit, ectAutoBuy } always; spend limits only in demo mode
 *   POST /api/scenario         { key: 'lv' } (one scenario today: Las Vegas GP 2026)
 *   POST /api/jobs/generate    { count? }: add 1–20 generated requests to the queue (default 5)
 *   POST /api/demo/run         { jobId? }: start the demo agent on one job or all
 *   POST /api/demo/emergency   the agent offsets the emergency air shipment (Emergency freight page)
 *   POST /api/demo/reset
 *
 * SECURITY NOTE: no authentication, because the server binds to localhost for the demo. Before
 * this is exposed anywhere, the owner must sign in (SolvaPay hosted sign-in or the app's own IdP),
 * because approving a payment here is the owner's authority. An agent must never reach these routes.
 */

import type { ServerResponse } from 'node:http';
import { providerFor, type HourlyForecast } from '../carbon/provider.ts';
import { SCENARIOS, type JobSpec, type ScenarioKey } from '../domain/scenarios.ts';
import { ectTokensFor, plan } from '../domain/planner.ts';
import { generateJobs, seededRandom } from '../domain/jobGenerator.ts';
import type { Approvals, Decision } from '../services/approvals.ts';
import type { EventBus } from '../services/events.ts';
import type { Store } from '../services/store.ts';
import type { Payments } from '../payments/solvapay.ts';
import { DEMO_AGENT } from '../payments/solvapay.ts';
import type { DemoAgent } from '../demo/demoAgent.ts';
import type { EctRegistry } from '../services/ectRegistry.ts';

export interface DashboardDeps {
  store: Store;
  approvals: Approvals;
  payments: Payments;
  bus: EventBus;
  agent: DemoAgent;
  ects: EctRegistry;
}

const json = (status: number, body: unknown) => Response.json(body, { status });

export function createDashboardApi(deps: DashboardDeps) {
  const { store, approvals, payments, bus, agent, ects } = deps;
  const forecastCache = new Map<string, { at: number; data: HourlyForecast[] }>();

  function reset(key: ScenarioKey): void {
    approvals.clear(); // wakes any waiting call so it finishes as expired
    payments.asked.clear();
    store.reset(key);
    ects.reset();
    payments.standIn?.reset(store.scenario.budget);
  }

  /** Chart data: the same provider the planner uses, cached 5 min so live APIs aren't hammered. */
  async function forecast(): Promise<HourlyForecast[]> {
    const sc = store.scenario;
    const hit = forecastCache.get(sc.key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.data;
    const provider = providerFor(sc);
    const data = await Promise.all(Object.keys(sc.zones).map(z => provider.forecast(z, 24)));
    forecastCache.set(sc.key, { at: Date.now(), data });
    return data;
  }

  /**
   * A request's carbon footprint and the ECT offset that matches it, for the Job queue.
   *   - booked jobs: the real slot and the ECT lot actually retired
   *   - everything else: an estimate from the same planner the agent uses (same cap, premium
   *     limit and ECT price), so the card shows what will happen before the agent runs
   */
  function footprint(job: Pick<JobSpec, 'id' | 'gpuh' | 'flex' | 'zones'>, forecasts: HourlyForecast[]) {
    const outcome = store.jobs.get(job.id);
    const lot = store.ect.lots.find(l => l.jobId === job.id);
    const ectPrice = store.scenario.ectPrice;
    let slot = outcome?.pick, baseline = outcome?.baseline, estimated = false;
    if (!slot || !baseline) {
      const p = plan(job, new Map(forecasts.map(f => [f.zone, f])), store.scenario.zones, store.carbonCap, {
        premiumRemaining: Math.max(0, store.greenPremiumLimit - store.premiumSpent),
        ectPrice: store.ect.autoBuy ? ectPrice : 0,
      });
      slot = p.pick; baseline = p.baseline; estimated = true;
    }
    const tokens = lot?.tokens ?? ectTokensFor(slot.kg);
    return {
      estimated,
      kg: slot.kg,
      baselineKg: baseline.kg,
      zone: slot.zone,
      tokens,
      ectCost: lot?.cost ?? Math.round(tokens * ectPrice * 10000) / 10000,
      lot: lot ? { lotId: lot.lotId, serialFrom: lot.serialFrom, serialTo: lot.serialTo } : null,
    };
  }

  async function state() {
    const sc = store.scenario;
    const forecasts = await forecast();
    let base = 0, green = 0, baseCost = 0, greenCost = 0, n = 0;
    const chosen: Record<string, unknown> = {};
    for (const [id, j] of store.jobs) {
      if (!j.pick || !j.baseline) continue;
      chosen[id] = { pick: j.pick, baseline: j.baseline };
      base += j.baseline.kg; green += j.pick.kg; baseCost += j.baseline.price; greenCost += j.pick.price; n++;
    }
    const counts = { auto: 0, asked: 0, refused: 0 };
    for (const j of store.jobs.values()) {
      if (j.status === 'auto') counts.auto++;
      if (j.status === 'appr' || j.status === 'dec') counts.asked++;
      if (j.status === 'ref') counts.refused++;
    }
    const si = payments.standIn;
    return {
      mode: payments.mode,
      agent: DEMO_AGENT,
      scenario: {
        key: sc.key, company: sc.company, holder: sc.holder, holderRole: sc.holderRole, source: sc.source, method: sc.method,
        granularity: sc.granularity, note: sc.note, capLabel: sc.capLabel, quoteFee: sc.quoteFee,
      },
      zones: Object.entries(sc.zones).map(([key, z]) => ({ key, name: z.name, price: z.price, color: z.color })),
      forecast: forecasts,
      jobs: store.queue.map(({ prompt: _p, ...j }) => ({ ...j, status: store.jobs.get(j.id)?.status ?? null, footprint: footprint(j, forecasts) })),
      policy: {
        carbonCap: store.carbonCap,
        // In sandbox mode the spend policy lives in SolvaPay and isn't readable here.
        budget: si ? { ...si.policy, spentToday: si.spentToday, spentThisMonth: si.spentThisMonth, editable: true } : null,
        greenPremium: { limit: store.greenPremiumLimit, spent: store.premiumSpent },
        qualityBar: store.qualityBar,
      },
      ect: {
        autoBuy: store.ect.autoBuy,
        pricePerToken: sc.ectPrice,
        lots: store.ect.lots,
        tokens: store.ect.lots.reduce((n, l) => n + l.tokens, 0),
        spent: store.ectSpent,
        emittedKg: green, // what the booked jobs still emit
      },
      approvals: approvals.pending(),
      ledger: store.ledger,
      log: store.log,
      chosen,
      kpis: { baseKg: base, greenKg: green, baseCost, greenCost: greenCost + store.fees + store.ectSpent, fees: store.fees, ectCost: store.ectSpent, jobs: n, ...counts },
      emergency: store.emergency,
      busy: store.busy,
    };
  }

  function startAgent(run: () => Promise<void>): Response {
    if (store.busy) return json(409, { error: { type: 'busy', message: 'The agent is already running' } });
    store.busy = true;
    store.changed();
    run()
      .catch(err => store.say('agent', `Crashed: ${err}`, { cls: 'no' }))
      .finally(() => { store.busy = false; store.changed(); });
    return json(202, { started: true });
  }

  return {
    /** SSE needs the raw Node response, so it's handled outside the fetch-style router. */
    events(res: ServerResponse): void {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      const unsubscribe = bus.subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000); // keeps proxies from closing it
      res.on('close', () => { clearInterval(ping); unsubscribe(); });
    },

    async handle(method: string, path: string, body: Record<string, unknown>): Promise<Response> {
      if (method === 'GET' && path === '/api/state') return json(200, await state());

      const approval = path.match(/^\/api\/approvals\/([\w-]+)$/);
      if (method === 'POST' && approval) {
        const decision = body.decision as Decision;
        if (!['approve', 'decline', 'raise'].includes(decision)) return json(400, { error: { type: 'invalid_decision' } });
        const a = approvals.get(approval[1]);
        if (!approvals.decide(approval[1], decision)) return json(409, { error: { type: 'not_pending', message: 'Already decided, expired, or cannot be raised' } });
        const words = { approve: 'Approved', decline: 'Declined', raise: 'Limit raised' }[decision];
        store.say(a?.kind === 'budget' ? 'solvapay' : 'gateway', `${words} by ${store.scenario.holder} on the dashboard.`, { cls: decision === 'decline' ? 'no' : 'ok', jobId: a?.jobId });
        return json(200, { ok: true });
      }

      if (method === 'PUT' && path === '/api/policy') {
        if (typeof body.carbonCap === 'number' && body.carbonCap >= 0) store.carbonCap = body.carbonCap;
        if (typeof body.greenPremiumLimit === 'number' && body.greenPremiumLimit >= 0) store.greenPremiumLimit = body.greenPremiumLimit;
        if (typeof body.qualityBar === 'number' && body.qualityBar >= 0 && body.qualityBar <= 100) store.qualityBar = body.qualityBar;
        if (typeof body.ectAutoBuy === 'boolean') store.ect.autoBuy = body.ectAutoBuy;
        const si = payments.standIn;
        for (const k of ['perCall', 'perDay', 'perMonth'] as const) {
          if (typeof body[k] !== 'number') continue;
          if (!si) return json(409, { error: { type: 'managed_in_solvapay', message: 'Spend limits are set in SolvaPay in sandbox mode' } });
          si.policy[k] = Math.max(0, body[k] as number);
        }
        store.changed();
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/scenario') {
        if (store.busy) return json(409, { error: { type: 'busy' } });
        const key = body.key as ScenarioKey;
        if (!(key in SCENARIOS)) return json(400, { error: { type: 'unknown_scenario' } });
        reset(key);
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/jobs/generate') {
        // Seeded by scenario + batch number, so after a Reset the same batches come out again.
        const count = Math.min(20, Math.max(1, Math.floor(Number(body.count) || 5)));
        const seed = 2000 + store.generatedBatches++;
        const added = generateJobs(store.scenario, store.queue, count, seededRandom(seed));
        store.queue.push(...added);
        store.say('agent', `Received ${added.length} new request${added.length === 1 ? '' : 's'}: ${added.map(j => `${j.id} (${j.process})`).join(', ')}`, { cls: 'h' });
        store.changed();
        return json(200, { added: added.map(j => j.id) });
      }

      if (method === 'POST' && path === '/api/demo/reset') {
        if (store.busy) return json(409, { error: { type: 'busy' } });
        reset(store.scenario.key);
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/demo/emergency') {
        const s = store.scenario.emergency;
        if (store.emergency.status !== 'idle' && store.emergency.status !== 'stopped') return json(409, { error: { type: 'already_run', message: 'Reset to run the emergency again' } });
        return startAgent(() => agent.emergency(s.id, s.item));
      }

      if (method === 'POST' && path === '/api/demo/run') {
        const jobs = store.queue;
        if (typeof body.jobId === 'string') {
          const job = jobs.find(j => j.id === body.jobId);
          if (!job) return json(404, { error: { type: 'unknown_job' } });
          if (store.jobs.has(job.id)) return json(409, { error: { type: 'already_run' } });
          return startAgent(() => agent.run(job));
        }
        return startAgent(() => agent.runAll(jobs));
      }

      return json(404, { error: { type: 'not_found' } });
    },
  };
}
