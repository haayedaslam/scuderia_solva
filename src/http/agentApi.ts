/**
 * The agent-facing API: what an AI agent calls to buy carbon-aware GPU time.
 *
 *   POST /v1/quotes    PAID (fraction of a cent). Buys the carbon forecast and returns a plan:
 *                      the cleanest slot under the owner's cap, or a flag that the owner must decide.
 *   POST /v1/bookings  PAID (the GPU time). Books a quote. Runs the gates in this order:
 *                        1. carbon gate (SolvaGreen):        owner approval if over the carbon cap
 *                        2. green-premium gate (SolvaGreen): owner approval if going green would
 *                                                            pass the daily cost-of-green limit
 *                        3. budget gate (SolvaPay):          authorize → book on the cloud → complete
 *                      then auto-buys ECTs (Emission Carbon Tokens) to offset what the job still
 *                      emits, as a separate SolvaPay-paid call.
 *
 * WHY SOLVAGREEN'S GATES GO FIRST: if the owner rejects the job on carbon or cost-of-green grounds,
 * SolvaPay is never asked. No money is held and the owner never gets a budget approval for a job
 * that won't run.
 *
 * Every paid call uses the SDK's HTTP gate: verify the agent, authorize with SolvaPay (which
 * enforces limits and approvals), run, then finish with the real cost so SolvaPay settles exactly
 * that. If anything fails after authorize, we `release` and nothing is charged.
 */

import { randomUUID } from 'node:crypto';
import { promptFacts } from '@solvapay/agents';
import { refusalResponse } from '@solvapay/agents/http';
import type { Refused } from '@solvapay/agents';
import { config } from '../config.ts';
import { providerFor, type HourlyForecast } from '../carbon/provider.ts';
import { ectTokensFor, plan, type Slot } from '../domain/planner.ts';
import { charterEmissions, chooseProject, REGISTRY_NAMES } from '../domain/freight.ts';
import { loadProjects } from '../carbon/carbonmark.ts';
import type { Approvals } from '../services/approvals.ts';
import type { GpuCloud } from '../services/cloud.ts';
import type { EctLot, EctRegistry } from '../services/ectRegistry.ts';
import type { Quote, Store } from '../services/store.ts';
import type { Payments } from '../payments/solvapay.ts';

export interface AgentApiDeps {
  store: Store;
  approvals: Approvals;
  payments: Payments;
  cloud: GpuCloud;
  ects: EctRegistry;
}

export interface AgentRequest {
  path: string;
  body: Record<string, unknown>;
  /** The bearer token: a SolvaPay agent token (JWT) or agent key (agk_…). */
  presentedKey: string;
  /** Idempotency-Key header. SolvaPay keys the call on it, so a retry continues the same call. */
  requestId: string;
  /** Fires if the agent disconnects, which ends any wait for the owner. */
  signal: AbortSignal;
}

const QUOTE_TTL_MS = 15 * 60_000;
const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;
const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00${h >= 24 ? ' +1d' : ''}`;
const ects_ = (n: number) => `${n} ECT${n === 1 ? '' : 's'}`; // "1 ECT", "3 ECTs"
const json = (status: number, body: unknown) => Response.json(body, { status });
const error = (status: number, type: string, message: string) => json(status, { error: { type, message } });

export function createAgentApi(deps: AgentApiDeps) {
  const { store, approvals, payments, cloud, ects } = deps;

  return async function handle(req: AgentRequest): Promise<Response> {
    if (req.path === '/v1/quotes') return quote(req);
    if (req.path === '/v1/bookings') return book(req);
    if (req.path === '/v1/offsets/emergency') return emergencyOffset(req);
    return error(404, 'not_found', 'Unknown endpoint');
  };

  // ── POST /v1/quotes ──────────────────────────────────────────────────────────
  async function quote(req: AgentRequest): Promise<Response> {
    const job = parseJob(req.body.job);
    if (!job) return error(400, 'invalid_request', 'Expected job: { id, name, gpuh, flex, zones[] }');
    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt : '';
    const maxPrice = typeof req.body.maxPrice === 'number' ? req.body.maxPrice : undefined;
    const sc = store.scenario;
    const fee = sc.quoteFee;

    const gated = await payments.gate({
      presentedKey: req.presentedKey,
      requestId: req.requestId,
      item: 'carbon-quote',
      estimate: { amount: fee.toFixed(3), currency: 'USD' },
      prompt: promptFacts(prompt),
      signal: req.signal,
      logFields: { jobId: job.id },
    });
    if (gated.kind === 'not_agent') return error(401, 'not_agent', 'Present a SolvaPay agent token or agent key');
    if (gated.kind === 'rejected') return error(gated.status, gated.reason, gated.detail);
    if (gated.kind === 'refused') return refuse(gated.refused, job.id, job.name, null, 'GPU cloud', gated.challenge);

    // Allowed: SolvaPay holds the fee. Now do the work it pays for.
    let forecasts: Map<string, HourlyForecast>;
    try {
      const provider = providerFor(sc);
      const list = await Promise.all(job.zones.map(z => provider.forecast(z, job.flex)));
      forecasts = new Map(list.map(f => [f.zone, f]));
    } catch (err) {
      await gated.allowed.release('carbon_provider_unreachable'); // nothing charged
      return error(502, 'carbon_provider_unreachable', String(err));
    }
    const p = plan(job, forecasts, sc.zones, store.carbonCap, {
      maxPrice,
      premiumRemaining: Math.max(0, store.greenPremiumLimit - store.premiumSpent),
      ectPrice: store.ect.autoBuy ? sc.ectPrice : 0,
    });
    await gated.allowed.finish({ status: 200, cost: { amount: fee, currency: 'USD' } });
    store.fees += fee;

    const source = forecasts.values().next().value!.source;
    const q: Quote = {
      id: `quo_${randomUUID().slice(0, 8)}`,
      jobId: job.id,
      jobName: job.name,
      gpuh: job.gpuh,
      principalRef: gated.agent.principalRef,
      agentRef: gated.agent.agentRef,
      prompt,
      plan: p,
      carbonSource: source,
      expiresAt: Date.now() + QUOTE_TTL_MS,
      booked: false,
    };
    store.quotes.set(q.id, q);

    store.say('gateway', `Bought ${source} forecast: ${job.zones.length} zone${job.zones.length > 1 ? 's' : ''} × ${job.flex + 1} h, compared ${p.considered} slots`, { cls: 'pay', amount: usd(fee), jobId: job.id });
    if (p.cleanestOverLimit) {
      const c = p.cleanestOverLimit;
      store.say('gateway', `Green-premium limit: the cleanest slot (${c.zone} @ ${hh(c.hour)}, +${usd(c.premium)}) doesn't fit, so picked ${p.pick.zone} @ ${hh(p.pick.hour)} (+${usd(p.pick.premium)})`, { jobId: job.id });
    }
    store.addLedger({
      hour: config.demo.startHour,
      merchant: `SolvaGreen · ${source}`,
      item: `Carbon quote · ${job.zones.join(', ')} · ${job.flex + 1} h`,
      amount: fee,
      intensity: null,
      kg: null,
      decision: { cls: 'meter', txt: '✓ within limit · metered' },
      jobId: job.id,
      callRef: gated.allowed.callRef,
    });

    return json(200, {
      quote: {
        id: q.id,
        expiresAt: new Date(q.expiresAt).toISOString(),
        carbonGate: p.carbonGate,
        premiumGate: p.premiumGate,
        cap: p.cap,
        pick: p.pick,
        baseline: p.baseline,
        considered: p.considered,
        source,
      },
    });
  }

  // ── POST /v1/bookings ────────────────────────────────────────────────────────
  async function book(req: AgentRequest): Promise<Response> {
    const q = store.quotes.get(String(req.body.quoteId ?? ''));
    if (!q) return error(404, 'quote_not_found', 'Unknown quote. Ask for a new one at /v1/quotes');
    if (q.booked) return error(409, 'quote_already_booked', 'This quote was already booked');
    if (q.expiresAt < Date.now()) return error(410, 'quote_expired', 'Quote expired: the grid has moved on. Ask for a new one');

    // Only the account the quote was issued to can book it.
    const who = await payments.agentLayer.identify(req.presentedKey);
    if (who.kind !== 'agent') return error(401, who.kind === 'rejected' ? who.reason : 'not_agent', 'Present a valid SolvaPay agent credential');
    if (who.agent.principalRef !== q.principalRef) return error(403, 'quote_not_yours', 'This quote was issued to another account');

    const { pick, baseline } = q.plan;
    const zoneName = store.scenario.zones[pick.zone].name;
    const merchant = `GPU cloud · ${zoneName}`;
    let carbonApproved = false;
    let premiumApproved = false;

    // ── Gate 1: carbon (SolvaGreen) ──
    if (q.plan.carbonGate === 'needs_approval') {
      store.say('gateway', `Carbon gate ✗: the cleanest slot allowed is ${pick.intensity.toFixed(0)} g/kWh, over the ${q.plan.cap} g/kWh cap. Asking the owner…`, { cls: 'no', jobId: q.jobId });
      const a = approvals.request({
        kind: 'carbon',
        jobId: q.jobId,
        title: 'Over your carbon cap',
        amount: pick.price,
        reasons: [`The cleanest slot this job allows is ${pick.intensity.toFixed(0)} g/kWh, over your ${q.plan.cap} g/kWh cap, and it can't wait.`],
        details: details(q, zoneName),
        canRaise: false,
      });
      const decided = await approvals.wait(a.id, config.solvapay.maxApprovalWaitSeconds * 1000, req.signal);
      if (decided.status === 'pending') {
        approvals.cancel(a.id); // agent gave up or timed out: take it off the owner's screen
        return error(402, 'carbon_approval_timed_out', 'The owner did not answer in time. Nothing was charged.');
      }
      if (decided.decision !== 'approve') {
        store.say('gateway', 'Declined by the owner on carbon. SolvaPay was never asked, so nothing was held or charged.', { cls: 'no', amount: usd(0), jobId: q.jobId });
        store.setJob(q.jobId, { status: 'dec' });
        store.addLedger(rowFor(q, merchant, 0, { cls: 'no', txt: 'carbon cap · asked · declined' }));
        return error(409, 'carbon_declined', 'The owner declined this job on carbon grounds. Nothing was charged.');
      }
      carbonApproved = true;
      store.say('gateway', 'Carbon override approved by the owner.', { cls: 'ok', jobId: q.jobId });
    } else {
      store.say('gateway', `Carbon gate ✓: ${pick.zone} @ ${hh(pick.hour)} is ${pick.intensity.toFixed(0)} g/kWh, under the ${q.plan.cap} cap`, { cls: 'ok', jobId: q.jobId });
    }

    // ── Gate 2: green premium (SolvaGreen) ──
    // Re-checked at booking time: other jobs may have used up the limit since the quote.
    const premiumLeft = store.greenPremiumLimit - store.premiumSpent;
    if (pick.premium > premiumLeft + 1e-9) {
      store.say('gateway', `Green-premium gate ✗: this job costs +${usd(pick.premium)} over the cheapest option, but only ${usd(Math.max(0, premiumLeft))} of the ${usd(store.greenPremiumLimit)}/day limit is left. Asking the owner…`, { cls: 'no', jobId: q.jobId });
      const a = approvals.request({
        kind: 'premium',
        jobId: q.jobId,
        title: 'Over your green-premium limit',
        amount: pick.price,
        reasons: [`Going green on this job costs +${usd(pick.premium)} more than the cheapest option${store.ect.autoBuy ? ` (incl. ${ects_(pick.ectTokens)})` : ''}. Only ${usd(Math.max(0, premiumLeft))} of your ${usd(store.greenPremiumLimit)}/day limit is left.`],
        details: { ...details(q, zoneName), 'Green premium': `+${usd(pick.premium)}` },
        canRaise: true,
      });
      const decided = await approvals.wait(a.id, config.solvapay.maxApprovalWaitSeconds * 1000, req.signal);
      if (decided.status === 'pending') {
        approvals.cancel(a.id);
        return error(402, 'premium_approval_timed_out', 'The owner did not answer in time. Nothing was charged.');
      }
      if (decided.decision === 'decline') {
        store.say('gateway', 'Declined by the owner on cost of going green. SolvaPay was never asked, so nothing was held or charged.', { cls: 'no', amount: usd(0), jobId: q.jobId });
        store.setJob(q.jobId, { status: 'dec' });
        store.addLedger(rowFor(q, merchant, 0, { cls: 'no', txt: 'green-premium limit · asked · declined' }));
        return error(409, 'premium_declined', 'The owner declined the extra cost of going green on this job. Nothing was charged.');
      }
      if (decided.decision === 'raise') {
        store.greenPremiumLimit = Math.ceil(store.premiumSpent + pick.premium);
        store.say('gateway', `Green-premium limit raised to ${usd(store.greenPremiumLimit)}/day by the owner.`, { cls: 'ok', jobId: q.jobId });
      }
      premiumApproved = true;
    }

    // ── Gate 3: budget (SolvaPay) ──
    store.say('gateway', `Asking SolvaPay to authorize ${usd(pick.price)} for ${q.gpuh} GPU-h in ${pick.zone}…`, { jobId: q.jobId });
    const gated = await payments.gate({
      presentedKey: req.presentedKey,
      requestId: req.requestId,
      item: `gpu-hours:${pick.zone}`,
      estimate: { amount: pick.price.toFixed(2), currency: 'USD' },
      prompt: promptFacts(q.prompt),
      signal: req.signal,
      logFields: { jobId: q.jobId, quoteId: q.id },
    });
    if (gated.kind === 'not_agent' || gated.kind === 'rejected') return error(401, 'invalid_agent', 'Agent credential not accepted');
    if (gated.kind === 'refused') return refuse(gated.refused, q.jobId, q.jobName, q, merchant, gated.challenge);

    const askedBudget = payments.asked.has(req.requestId);
    store.say('solvapay', `✓ Authorized${askedBudget ? ' by the owner' : ' within limits'}. ${usd(Number(gated.allowed.reservation.held.amount))} held`, { cls: 'ok', jobId: q.jobId });

    // Book the GPU time. If the cloud can't be reached, release the hold so nothing is charged.
    let booking;
    try {
      booking = await cloud.book({ zone: pick.zone, startOffsetHours: pick.offset, gpuHours: q.gpuh, pricePerGpuHour: store.scenario.zones[pick.zone].price });
    } catch (err) {
      await gated.allowed.release('cloud_unreachable');
      return error(502, 'cloud_unreachable', 'The GPU cloud could not be reached. Nothing was charged.');
    }
    const settlement = await gated.allowed.finish({ status: booking.status, cost: booking.status < 400 ? { amount: booking.cost, currency: 'USD' } : null });
    if (booking.status >= 400) return error(502, 'booking_failed', 'The cloud refused the booking. Nothing was charged.');
    if (!settlement) store.say('solvapay', 'Could not report the final cost to SolvaPay. The hold lapses at the estimate.', { cls: 'no', jobId: q.jobId });
    q.booked = true;

    const auto = !carbonApproved && !premiumApproved && !askedBudget;
    const avoided = baseline.kg - pick.kg;
    store.setJob(q.jobId, { status: auto ? 'auto' : 'appr', pick, baseline });
    const decision = auto
      ? { cls: 'ok' as const, txt: '✓ within limit · carbon ✓' }
      : { cls: 'ask' as const, txt: `asked you · ${[carbonApproved && 'carbon', premiumApproved && 'premium', askedBudget && 'budget'].filter(Boolean).join(' + ')} approved` };
    const row = store.addLedger({ ...rowFor(q, merchant, booking.cost, decision), callRef: gated.allowed.callRef, bookingId: booking.bookingId });
    store.say('gateway', `Booked ${hh(pick.hour)} in ${pick.zone}. Settled at ${usd(booking.cost)}. ${avoided > 0.05 ? `Avoided ${avoided.toFixed(1)} kg vs budget-only.` : ''}`, { cls: 'ok', amount: usd(booking.cost), jobId: q.jobId });

    // Offset what the job still emits. A failure here never undoes the booking.
    const lot = store.ect.autoBuy && pick.kg > 0 ? await buyEcts(req, q, pick) : null;

    // What the agent gets back: the essentials of what it bought.
    return json(200, {
      receipt: {
        transactionId: row.id,
        callRef: row.callRef,
        bookingId: row.bookingId,
        zone: pick.zone,
        startsAt: hh(pick.hour),
        amount: { value: booking.cost, currency: 'USD' },
        intensity: pick.intensity,
        kgCo2e: pick.kg,
        avoidedKg: avoided,
        decision: decision.txt,
        offset: lot ? { lotId: lot.lotId, tokens: lot.tokens, cost: lot.cost, serials: `${lot.serialFrom}…${lot.serialTo}` } : null,
      },
    });
  }

  /**
   * ECT auto-buy: purchases enough Emission Carbon Tokens (1 ECT = 1 kgCO2e, rounded up) to offset
   * a booked job's remaining emissions, and retires them. Paid through SolvaPay like any other call,
   * with its own requestId so a retry of the booking never buys twice.
   */
  async function buyEcts(req: AgentRequest, q: Quote, pick: Slot): Promise<EctLot | null> {
    const price = store.scenario.ectPrice;
    const tokens = ectTokensFor(pick.kg);
    const estimate = tokens * price;
    store.say('gateway', `Auto-buying ${ects_(tokens)} to offset the remaining ${pick.kg.toFixed(1)} kg…`, { jobId: q.jobId });

    const gated = await payments.gate({
      presentedKey: req.presentedKey,
      requestId: `${req.requestId}:ect`,
      item: 'ect-offset',
      estimate: { amount: estimate.toFixed(4), currency: 'USD' },
      prompt: promptFacts(`Offset the residual emissions of ${q.jobName}`),
      signal: req.signal,
      logFields: { jobId: q.jobId, quoteId: q.id },
    });
    if (gated.kind !== 'allowed') {
      const reason = gated.kind === 'refused' ? gated.refused.reason : gated.kind;
      store.say('solvapay', `✗ ECT purchase refused (${reason}). The job stays booked; emissions are not offset.`, { cls: 'no', jobId: q.jobId });
      store.addLedger({ hour: pick.hour, merchant: 'ECT registry', item: `${ects_(tokens)} · offsets ${q.jobId}`, amount: 0, intensity: null, kg: null, decision: { cls: 'no', txt: `Refused · ${reason}` }, jobId: q.jobId });
      return null;
    }

    let bought;
    try {
      bought = await ects.buy({ tokens, pricePerToken: price });
    } catch {
      await gated.allowed.release('ect_registry_unreachable');
      store.say('gateway', 'ECT registry unreachable. Nothing was charged; emissions are not offset.', { cls: 'no', jobId: q.jobId });
      return null;
    }
    await gated.allowed.finish({ status: bought.status, cost: bought.status < 400 ? { amount: bought.cost, currency: 'USD' } : null });
    if (bought.status >= 400) return null;

    const lot: EctLot = {
      lotId: bought.lotId, serialFrom: bought.serialFrom, serialTo: bought.serialTo,
      tokens, pricePerToken: price, cost: bought.cost, status: 'retired',
      jobId: q.jobId, jobName: q.jobName, zone: pick.zone, kgOffset: pick.kg,
      callRef: gated.allowed.callRef, ts: store.now().toISOString(),
    };
    store.ect.lots.push(lot);
    store.addLedger({
      hour: pick.hour, merchant: 'ECT registry', item: `${ects_(tokens)} · offsets ${q.jobId} in ${pick.zone}`,
      amount: bought.cost, intensity: null, kg: -tokens,
      decision: { cls: 'meter', txt: '✓ auto-buy · retired' }, jobId: q.jobId, callRef: gated.allowed.callRef,
    });
    store.say('gateway', `Retired ${ects_(tokens)} (${bought.serialFrom} … ${bought.serialTo}). ${q.jobId} is now carbon-neutral.`, { cls: 'ok', amount: usd(bought.cost), jobId: q.jobId });
    return lot;
  }

  // ── POST /v1/offsets/emergency ───────────────────────────────────────────────
  /**
   * The "ACT" flow: an urgent shipment that can't wait for a cleaner option (an air charter for a
   * spare part) is offset at the moment of decision.
   *   1. calculate the shipment's emissions (src/domain/freight.ts, every assumption listed)
   *   2. check Carbonmark projects and score them against the owner's quality bar   ← SolvaGreen gate
   *   3. SolvaPay authorizes the credit purchase against the spend policy          ← SolvaPay gate
   *   4. retire the credits and issue a certificate tied to the shipment, then complete at the real cost
   * Both gates passing means it auto-executes: no approval queue. The retirement is SIMULATED in
   * this demo; production would call Carbonmark's retirement API at step 4.
   * The short pauses only pace the demo so the audience can follow each step (0 in tests).
   */
  async function emergencyOffset(req: AgentRequest): Promise<Response> {
    const s = store.scenario.emergency;
    if (req.body.shipmentId !== s.id) return error(404, 'shipment_not_found', 'Unknown shipment');
    const who = await payments.agentLayer.identify(req.presentedKey);
    if (who.kind !== 'agent') return error(401, 'not_agent', 'Present a valid SolvaPay agent credential');
    const pace = () => new Promise(r => setTimeout(r, config.demo.paceMs * 3));
    const startedMs = Date.now(); // real time, for how long the steps took
    const e = store.emergency = { status: 'calculating' as const, shipment: s, triggeredAt: store.now().toISOString() } as typeof store.emergency;
    store.changed();

    // 1. Emissions
    const calc = charterEmissions(s);
    await pace();
    Object.assign(e, { calc, status: 'checking' });
    store.say('gateway', `Emergency ${s.id}: ${s.from.code} → ${s.to.code} air charter ≈ ${calc.tCO2.toFixed(1)} tCO₂ (${Math.round(calc.fuelKg).toLocaleString('en-US')} kg fuel). Needs ${calc.credits} credits.`, { cls: 'h' });
    store.changed();

    // 2. Quality gate (SolvaGreen): score Carbonmark projects against the owner's bar
    const feed = await loadProjects();
    const { candidates, chosen } = chooseProject(feed.projects, calc.credits, store.qualityBar);
    await pace();
    Object.assign(e, { feedSource: feed.source, candidates, chosen });
    const passing = candidates.filter(p => p.verdict === 'chosen' || p.verdict === 'pass').length;
    if (!chosen) {
      Object.assign(e, { status: 'stopped', gates: { quality: { pass: false, detail: `No project with enough supply scores ${store.qualityBar}+` } }, error: 'No credits meet the quality bar. Nothing was bought.' });
      store.say('gateway', `Quality gate ✗: none of ${candidates.length} Carbonmark projects clears the bar of ${store.qualityBar}. Nothing bought.`, { cls: 'no' });
      store.changed();
      return error(422, 'quality_bar_not_met', 'No credits meet the quality bar. Nothing was bought.');
    }
    const cost = Math.round(calc.credits * chosen.pricePerTonne * 100) / 100;
    e.cost = cost;
    e.gates = { quality: { pass: true, detail: `${chosen.key} scores ${chosen.score.total}/100 (Tier ${chosen.tier}) ≥ bar ${store.qualityBar} · ${passing} of ${candidates.length} projects pass` } };
    e.status = 'paying';
    store.say('gateway', `Quality gate ✓: ${chosen.key} ${chosen.name.slice(0, 48)}… scores ${chosen.score.total}/100. ${candidates.length - passing} cheaper or weaker projects rejected.`, { cls: 'ok' });
    store.changed();
    await pace();

    // 3. Budget gate (SolvaPay): authorize the purchase
    const gated = await payments.gate({
      presentedKey: req.presentedKey,
      requestId: req.requestId,
      item: `carbon-credits:${chosen.key}`,
      estimate: { amount: cost.toFixed(2), currency: 'USD' },
      prompt: promptFacts(`Offset emergency air shipment ${s.id}: ${s.item}`),
      signal: req.signal,
      logFields: { shipmentId: s.id },
    });
    if (gated.kind !== 'allowed') {
      const reason = gated.kind === 'refused' ? gated.refused.reason : gated.kind;
      Object.assign(e, { status: 'stopped', error: `SolvaPay refused (${reason}). Nothing was bought.` });
      e.gates!.budget = { pass: false, detail: `Refused: ${reason}` };
      store.say('solvapay', `✗ Credit purchase refused (${reason}). Nothing was bought.`, { cls: 'no' });
      store.changed();
      return gated.kind === 'refused' ? refusalResponse(gated.refused, gated.challenge) : error(401, 'invalid_agent', 'Agent credential not accepted');
    }
    const askedOwner = payments.asked.has(req.requestId);
    const merchantLimit = store.scenario.budget.perMerchant?.['carbon-credits'];
    e.gates!.budget = { pass: true, detail: askedOwner ? `Approved by ${store.scenario.holder}` : `${usd(cost)} within the ${merchantLimit ? `$${merchantLimit.perCall.toLocaleString('en-US')} carbon-credit` : ''} per-call limit` };
    e.gates!.autoExecuted = !askedOwner;
    store.say('solvapay', `✓ Authorized ${usd(cost)}${askedOwner ? ' by the owner' : ' within limits: auto-executed, no approval queue'}.`, { cls: 'ok' });
    store.changed();
    await pace();

    // 4. Retire (simulated) + certificate, then settle at the real cost
    // The emergency happens after FP3: Friday 17:42 Las Vegas time, plus however long the steps took.
    const local = new Date(Date.UTC(2026, 10, 20, 17, 42) + (Date.now() - startedMs));
    const certId = `SG-RET-2026-${String(++store.certificates).padStart(5, '0')}`;
    const settlement = await gated.allowed.finish({ status: 200, cost: { amount: cost, currency: 'USD' } });
    e.certificate = {
      id: certId,
      issued: `${local.toISOString().slice(0, 10)} ${local.toISOString().slice(11, 16)} PST (Las Vegas)`,
      beneficiary: 'McLaren Racing',
      authorisedBy: `${store.scenario.holder} · via pitwall-agent`,
      shipment: `${s.id} · ${s.item} · ${s.from.code} → ${s.to.code} air charter`,
      emissions: `${calc.tCO2.toFixed(1)} tCO₂`,
      tonnesRetired: calc.credits,
      project: `${chosen.key} · ${chosen.name}`,
      registry: REGISTRY_NAMES[chosen.registry] ?? chosen.registry,
      vintage: chosen.vintage ?? '—',
      country: chosen.country,
      type: chosen.type,
      pricePerTonne: chosen.pricePerTonne,
      cost,
      solvapayCallRef: gated.allowed.callRef,
      settled: settlement ? 'Stripe · direct to merchant · held by SolvaPay $0' : 'pending',
      status: 'Simulated retirement (demo). Production: retired via Carbonmark.',
    };
    e.status = 'done';
    store.addLedger({
      hour: 17, merchant: 'Carbonmark · carbon credits', item: `${calc.credits} t ${chosen.key} · offsets ${s.id} air charter`,
      amount: cost, intensity: null, kg: -calc.credits * 1000,
      decision: askedOwner ? { cls: 'ask', txt: 'asked you · approved' } : { cls: 'ok', txt: '✓ budget + quality · auto-executed' },
      jobId: s.id, callRef: gated.allowed.callRef,
    });
    store.say('gateway', `Retired ${calc.credits} t of ${chosen.key}. Certificate ${certId} issued for ${s.id}.`, { cls: 'ok', amount: usd(cost) });
    store.changed();
    return json(200, { certificate: e.certificate });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  /** A refusal from SolvaPay: record it on the statement, then answer in SolvaPay's error format. */
  function refuse(refused: Refused, jobId: string, jobName: string, q: Quote | null, merchant: string, challenge?: Headers): Response {
    const offPurpose = refused.reason === 'deny';
    const declined = refused.reason === 'approval_declined';
    store.say('solvapay', `✗ Refused (${refused.reason}): ${refused.message}`, { cls: 'no', amount: usd(0), jobId });
    store.setJob(jobId, { status: declined ? 'dec' : 'ref' });
    const decision = { cls: 'no' as const, txt: offPurpose ? 'Refused · outside purpose' : declined ? 'spend limit · asked · declined' : `Refused · ${refused.reason}` };
    store.addLedger(q
      ? rowFor(q, merchant, 0, decision)
      : { hour: config.demo.startHour, merchant, item: jobName, amount: 0, intensity: null, kg: null, decision, jobId });
    return refusalResponse(refused, challenge);
  }

  /** A statement row for a GPU purchase (or a declined/refused one, with amount 0). */
  function rowFor(q: Quote, merchant: string, amount: number, decision: { cls: 'ok' | 'ask' | 'no'; txt: string }) {
    const { pick } = q.plan;
    return {
      hour: pick.hour,
      merchant,
      item: `${q.jobName} · ${q.gpuh} GPU-h`,
      amount,
      intensity: pick.intensity,
      kg: amount > 0 ? pick.kg : 0, // nothing emitted if it never ran
      decision,
      jobId: q.jobId,
    };
  }
}

function details(q: Quote, zoneName: string): Record<string, string> {
  const p = q.plan.pick;
  return {
    For: `${q.jobName} · ${q.gpuh} GPU-h`,
    Merchant: `GPU cloud · ${zoneName}`,
    Slot: hh(p.hour),
    'Grid intensity': `${p.intensity.toFixed(0)} gCO₂/kWh · ${q.carbonSource}`,
    Emissions: `${p.kg.toFixed(1)} kgCO₂e`,
  };
}

function parseJob(v: unknown): { id: string; name: string; gpuh: number; flex: number; zones: string[] } | null {
  if (!v || typeof v !== 'object') return null;
  const j = v as Record<string, unknown>;
  if (typeof j.id !== 'string' || typeof j.name !== 'string' || typeof j.gpuh !== 'number' || j.gpuh <= 0) return null;
  if (typeof j.flex !== 'number' || j.flex < 0 || j.flex > 72 || !Array.isArray(j.zones) || !j.zones.length) return null;
  if (!j.zones.every(z => typeof z === 'string')) return null;
  return { id: j.id, name: j.name, gpuh: j.gpuh, flex: Math.floor(j.flex), zones: j.zones as string[] };
}
