/**
 * Tests for the two-gate flow. Run with `npm test`.
 *
 * The important guarantees, each pinned by a test:
 *   1. A clean job is authorized by SolvaPay and settled at the cloud's real cost.
 *   2. A carbon decline means SolvaPay is NEVER called: no hold, no charge.
 *   3. A SolvaPay refusal means the cloud is NEVER booked.
 *   4. Off-purpose requests are refused before anything is bought.
 *   5. A quote can only be booked by the account it was issued to, and only once.
 *   6. ECTs are auto-bought after a booking to offset what it still emits (and not when switched off).
 *   7. The green-premium limit steers the planner, and a decline stops the job before SolvaPay is asked.
 *
 * Tests 2–3 use the SDK's official in-memory SolvaPay (`FakeAgentApi`), so they check our use of
 * the real SDK contract rather than our own stand-in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAgentApi } from '@solvapay/agents/testing';
import { createApp } from '../src/server.ts';
import { plan } from '../src/domain/planner.ts';
import { mockProvider } from '../src/carbon/provider.ts';
import { SCENARIOS } from '../src/domain/scenarios.ts';
import { generateJobs, seededRandom } from '../src/domain/jobGenerator.ts';
import { charterEmissions, chooseProject, scoreProject } from '../src/domain/freight.ts';
import { loadProjects } from '../src/carbon/carbonmark.ts';
import type { GpuCloud } from '../src/services/cloud.ts';

process.env.DEMO_PACE_MS = '0';

const SC = SCENARIOS.lv; // McLaren · Las Vegas GP 2026
const job = (id: string) => SC.jobs.find(j => j.id === id)!;

async function start(overrides: Parameters<typeof createApp>[0] = {}) {
  const app = await createApp(overrides);
  const url = await app.listen(0, '127.0.0.1');
  const token = await app.payments.credential();
  const post = async (path: string, body: unknown, key = crypto.randomUUID(), auth = token) => {
    const res = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}`, 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const quote = (id: string) => {
    const j = job(id);
    return post('/v1/quotes', { job: { id: j.id, name: j.name, gpuh: j.gpuh, flex: j.flex, zones: j.zones }, prompt: j.prompt });
  };
  return { app, url, post, quote, close: () => app.server.close() };
}

/** Answers the first approval that appears with `decision`. */
function answerNextApproval(app: Awaited<ReturnType<typeof createApp>>, decision: 'approve' | 'decline') {
  const timer = setInterval(() => {
    const [a] = app.approvals.pending();
    if (a) { app.approvals.decide(a.id, decision); clearInterval(timer); }
  }, 10);
  return () => clearInterval(timer);
}

test('planner: picks the cleanest slot under the cap, ignoring the cheaper dirty one', async () => {
  const j = job('J1'); // overnight CFD, any US grid
  const fc = new Map(await Promise.all(j.zones.map(async z => [z, await mockProvider(SC).forecast(z, j.flex)] as const)));
  const p = plan(j, fc, SC.zones, 350);
  assert.equal(p.baseline.zone, 'PJM'); // cheapest, dirtiest
  assert.equal(p.pick.zone, 'CAISO_NORTH'); // California midday solar
  assert.equal(p.pick.hour, 13);
  assert.equal(p.carbonGate, 'pass');
  assert.ok(p.pick.kg < p.baseline.kg / 4);
});

test('planner: flags owner approval when nothing is under the cap', async () => {
  const j = job('J3'); // Q2 strategy: trackside in Las Vegas, must run now
  const fc = new Map([['NEVP', await mockProvider(SC).forecast('NEVP', 0)]]);
  assert.equal(plan(j, fc, SC.zones, 350).carbonGate, 'needs_approval');
});

test('clean job: SolvaPay authorizes, cloud books, settles at the real cost', async () => {
  const api = new FakeAgentApi();
  const t = await start({ client: api });
  try {
    const q = await t.quote('J1');
    assert.equal(q.status, 200);
    assert.equal(q.body.quote.carbonGate, 'pass');
    const b = await t.post('/v1/bookings', { quoteId: q.body.quote.id });
    assert.equal(b.status, 200);
    assert.equal(api.authorizes.length, 3); // the quote fee + the GPU time + the ECT offset
    assert.equal(api.authorizes[1].estimate.amount, '96.00');
    assert.equal(api.completes[1].status, 200);
    assert.equal(api.completes[1].cost?.amount, '96');
    assert.equal(b.body.receipt.zone, 'CAISO_NORTH');
    assert.equal(b.body.receipt.callRef, t.app.store.ledger.find(r => r.merchant.startsWith('GPU cloud'))!.callRef);
  } finally { t.close(); }
});

test('carbon decline: SolvaPay is never asked to authorize the GPU spend', async () => {
  const api = new FakeAgentApi();
  const t = await start({ client: api });
  try {
    const q = await t.quote('J3');
    assert.equal(q.body.quote.carbonGate, 'needs_approval');
    const stop = answerNextApproval(t.app, 'decline');
    const b = await t.post('/v1/bookings', { quoteId: q.body.quote.id });
    stop();
    assert.equal(b.status, 409);
    assert.equal(b.body.error.type, 'carbon_declined');
    assert.equal(api.authorizes.length, 1); // only the quote fee, never the GPU time
    assert.equal(t.app.store.ledger.at(-1)!.decision.txt, 'carbon cap · asked · declined');
  } finally { t.close(); }
});

test('SolvaPay refusal: the cloud is never booked and nothing is charged', async () => {
  const api = new FakeAgentApi();
  let booked = 0;
  const cloud: GpuCloud = { async book() { booked++; return { bookingId: 'x', status: 200, cost: 1 }; } };
  const t = await start({ client: api, cloud });
  try {
    const q = await t.quote('J1');
    api.outcome = 'refused';
    api.refusal = { reason: 'deny', message: 'Over the per-call cap.' };
    const b = await t.post('/v1/bookings', { quoteId: q.body.quote.id });
    assert.equal(b.status, 422);
    assert.equal(b.body.error.type, 'deny');
    assert.equal(booked, 0);
  } finally { t.close(); }
});

test('demo stand-in: over-limit job waits for the owner, then settles', async () => {
  const t = await start(); // default demo stand-in
  try {
    const q = await t.quote('J4'); // California at $288 > $180 per-call limit
    const stop = answerNextApproval(t.app, 'approve');
    const b = await t.post('/v1/bookings', { quoteId: q.body.quote.id });
    stop();
    assert.equal(b.status, 200);
    assert.match(b.body.receipt.decision, /budget approved/);
    // quote fee + GPU time + 12 ECTs at $0.045 to offset the 11.1 kg it still emits
    assert.equal(Math.round(t.app.payments.standIn!.spentToday * 1000) / 1000, 288.541);
  } finally { t.close(); }
});

test('demo stand-in: injected off-purpose request is refused at the quote', async () => {
  const t = await start();
  try {
    const q = await t.quote('J5');
    assert.equal(q.status, 422);
    assert.equal(q.body.error.type, 'deny');
    assert.equal(t.app.payments.standIn!.spentToday, 0);
  } finally { t.close(); }
});

test('ECT auto-buy: offsets the remaining emissions, rounded up to whole tokens', async () => {
  const api = new FakeAgentApi();
  const t = await start({ client: api });
  try {
    const q = await t.quote('J1'); // California, ~3.7 kg left after shifting
    const b = await t.post('/v1/bookings', { quoteId: q.body.quote.id });
    assert.equal(b.body.receipt.offset.tokens, 4);
    assert.equal(api.authorizes[2].item, 'ect-offset');
    assert.equal(api.authorizes[2].estimate.amount, '0.1800');
    const [lot] = t.app.store.ect.lots;
    assert.equal(lot.serialFrom, 'ECT-2026-000001');
    assert.equal(lot.status, 'retired');
    assert.equal(t.app.store.ledger.at(-1)!.merchant, 'ECT registry');
  } finally { t.close(); }
});

test('ECT auto-buy switched off: no offset is bought', async () => {
  const api = new FakeAgentApi();
  const t = await start({ client: api });
  try {
    t.app.store.ect.autoBuy = false;
    const q = await t.quote('J1');
    const b = await t.post('/v1/bookings', { quoteId: q.body.quote.id });
    assert.equal(b.body.receipt.offset, null);
    assert.equal(api.authorizes.length, 2);
    assert.equal(t.app.store.ect.lots.length, 0);
  } finally { t.close(); }
});

test('planner: the green-premium limit steers it to a cheaper clean slot', async () => {
  const sc = SC;
  const j = job('J4');
  const fc = new Map(await Promise.all(j.zones.map(async z => [z, await mockProvider(sc).forecast(z, j.flex)] as const)));
  const free = plan(j, fc, sc.zones, 350, { ectPrice: sc.ectPrice });
  assert.equal(free.pick.zone, 'CAISO_NORTH'); // cleanest, +$78 premium
  const limited = plan(j, fc, sc.zones, 350, { ectPrice: sc.ectPrice, premiumRemaining: 60 });
  assert.equal(limited.pick.zone, 'BPA'); // still under the cap, fits the limit
  assert.equal(limited.premiumGate, 'pass');
  assert.equal(limited.cleanestOverLimit?.zone, 'CAISO_NORTH');
  assert.equal(plan(j, fc, sc.zones, 350, { ectPrice: sc.ectPrice, premiumRemaining: 5 }).premiumGate, 'needs_approval');
});

test('green-premium decline: SolvaPay is never asked to authorize the GPU spend', async () => {
  const api = new FakeAgentApi();
  const t = await start({ client: api });
  try {
    t.app.store.greenPremiumLimit = 1; // J1 costs ~$26 more than the cheapest option
    const q = await t.quote('J1');
    assert.equal(q.body.quote.premiumGate, 'needs_approval');
    const stop = answerNextApproval(t.app, 'decline');
    const b = await t.post('/v1/bookings', { quoteId: q.body.quote.id });
    stop();
    assert.equal(b.status, 409);
    assert.equal(b.body.error.type, 'premium_declined');
    assert.equal(api.authorizes.length, 1); // only the quote fee
  } finally { t.close(); }
});

test('generator: varied, valid requests that continue the ID sequence', () => {
  for (const sc of [SC]) {
    const jobs = generateJobs(sc, sc.jobs, 40, seededRandom(7));
    assert.equal(jobs.length, 40);
    assert.equal(jobs[0].id, 'J6');
    assert.equal(new Set(jobs.map(j => j.id)).size, 40); // unique IDs
    for (const j of jobs) {
      assert.ok(j.zones.length >= 1 && j.zones.every(z => z in sc.zones), `${j.id} uses unknown zone`);
      assert.ok(j.gpuh > 0 && j.flex >= 0 && j.flex <= 24);
      assert.ok(j.name && j.note && j.prompt);
    }
    assert.ok(new Set(jobs.map(j => j.process)).size >= 6, 'covers most race-weekend disciplines');
    assert.ok(jobs.some(j => j.flex === 0) && jobs.some(j => j.zones.length === 1) && jobs.some(j => j.zones.length > 1));
  }
});

test('generator: same seed, same requests (repeatable demos)', () => {
  const a = generateJobs(SC, [], 10, seededRandom(42));
  const b = generateJobs(SC, [], 10, seededRandom(42));
  assert.deepEqual(a, b);
});

test('generator: never repeats a request already in the queue', () => {
  for (const sc of [SC]) {
    const first = generateJobs(sc, sc.jobs, 10, seededRandom(1));
    const second = generateJobs(sc, [...sc.jobs, ...first], 10, seededRandom(2));
    const names = [...sc.jobs, ...first, ...second].map(j => j.name);
    assert.equal(new Set(names).size, names.length, 'duplicate request name');
  }
});

test('generated requests run end to end through the gateway', async () => {
  const t = await start();
  try {
    const res = await fetch(t.url + '/api/jobs/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 3 }) });
    const { added } = await res.json() as { added: string[] };
    assert.deepEqual(added, ['J6', 'J7', 'J8']);
    assert.equal(t.app.store.queue.length, 8);
    const g = t.app.store.queue.find(j => j.id === 'J6')!;
    const q = await t.post('/v1/quotes', { job: { id: g.id, name: g.name, gpuh: g.gpuh, flex: g.flex, zones: g.zones }, prompt: g.prompt });
    assert.equal(q.status, 200);
  } finally { t.close(); }
});

test('quotes: cannot be booked twice, and must be a quote the gateway issued', async () => {
  const t = await start();
  try {
    const q = await t.quote('J1');
    assert.equal((await t.post('/v1/bookings', { quoteId: q.body.quote.id })).status, 200);
    assert.equal((await t.post('/v1/bookings', { quoteId: q.body.quote.id })).status, 409);
    assert.equal((await t.post('/v1/bookings', { quoteId: 'quo_forged' })).status, 404);
  } finally { t.close(); }
});

// ── Emergency freight: emissions, quality gate, SolvaPay gate, certificate ─────────

test('freight: charter emissions follow the documented fuel-based method', () => {
  const e = charterEmissions(SC.emergency);
  assert.ok(Math.abs(e.greatCircleKm - 8392) < 5, `FAB→LAS great circle ${e.greatCircleKm}`);
  // fuel = (km × 1.05 / 850 + 0.5) × 1450 ; tCO2 = fuel × 3.16 / 1000
  const expected = ((e.greatCircleKm * 1.05 / 850 + 0.5) * 1450 * 3.16) / 1000;
  assert.ok(Math.abs(e.tCO2 - expected) < 1e-9);
  assert.equal(e.credits, Math.ceil(e.tCO2));
  assert.equal(e.credits, 50);
});

test('freight: the quality rubric rejects cheap avoidance credits and picks the cheapest that passes', async () => {
  const { projects } = await loadProjects(); // the committed Carbonmark snapshot
  const { chosen, candidates } = chooseProject(projects, 50, 70);
  assert.equal(chosen?.key, 'VCS-1764'); // Verra mangrove reforestation, 2020, $37.80/t
  assert.ok(candidates.filter(p => p.type === 'Avoidance (renewables)').every(p => p.verdict !== 'pass' && p.verdict !== 'chosen'));
  assert.ok(candidates.some(p => p.verdict === 'pass' && p.pricePerTonne > chosen!.pricePerTonne), 'a pricier project also passes but is not chosen');
  const old = scoreProject({ key: 'X', name: 'Old wind', registry: 'VCS', country: 'IN', vintages: ['2012'], pricePerTonne: 0.5, methodologyId: 'ACM0002', methodology: null, category: 'Renewable Energy', supplyTonnes: 1e6 });
  assert.equal(old.tier, 'C');
});

test('emergency: both gates pass → auto-executed, certificate tied to the shipment', async () => {
  const api = new FakeAgentApi();
  const t = await start({ client: api });
  try {
    const r = await t.post('/v1/offsets/emergency', { shipmentId: SC.emergency.id });
    assert.equal(r.status, 200);
    assert.equal(api.authorizes.length, 1);
    assert.equal(api.authorizes[0].item, 'carbon-credits:VCS-1764');
    assert.equal(api.authorizes[0].estimate.amount, '1890.00'); // 50 t × $37.80
    assert.equal(api.completes[0].cost?.amount, '1890');
    assert.equal(r.body.certificate.tonnesRetired, 50);
    assert.match(String(r.body.certificate.shipment), /SHP-0417/);
    assert.equal(t.app.store.emergency.gates?.autoExecuted, true);
  } finally { t.close(); }
});

test('emergency: quality bar not met → nothing bought, SolvaPay never asked', async () => {
  const api = new FakeAgentApi();
  const t = await start({ client: api });
  try {
    t.app.store.qualityBar = 95; // nothing in the snapshot scores 95
    const r = await t.post('/v1/offsets/emergency', { shipmentId: SC.emergency.id });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.type, 'quality_bar_not_met');
    assert.equal(api.authorizes.length, 0);
  } finally { t.close(); }
});

test('emergency (demo stand-in): the carbon-credit per-merchant limit lets $1,890 through without raising the $180 GPU limit', async () => {
  const t = await start();
  try {
    const r = await t.post('/v1/offsets/emergency', { shipmentId: SC.emergency.id });
    assert.equal(r.status, 200);
    assert.equal(t.app.approvals.pending().length, 0); // no approval was needed
    assert.equal(t.app.payments.standIn!.policy.perCall, 180);
    assert.equal(t.app.payments.standIn!.spentToday, 1890);
  } finally { t.close(); }
});

test('agent API rejects callers without a SolvaPay agent credential', async () => {
  const t = await start();
  try {
    const j = job('J1');
    const r = await t.post('/v1/quotes', { job: { id: j.id, name: j.name, gpuh: j.gpuh, flex: j.flex, zones: j.zones } }, undefined, 'not-a-token');
    assert.equal(r.status, 401);
  } finally { t.close(); }
});
