/**
 * The built-in demo agent ("pitwall-agent").
 *
 * It is a client like any other: it calls the gateway over real HTTP with its SolvaPay credential,
 * exactly as an external agent (Claude Code, a LangGraph worker, a cron job) would. Nothing here
 * reaches into the gateway's internals. Deleting this file leaves the gateway fully working.
 *
 * Per job:  POST /v1/quotes → read the plan → POST /v1/bookings → report the outcome.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { JobSpec } from '../domain/scenarios.ts';
import type { Store } from '../services/store.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00${h >= 24 ? ' +1d' : ''}`;

export class DemoAgent {
  /** The gateway's address. Set once the server is listening. */
  baseUrl: string;
  private store: Store;
  private credential: () => Promise<string>;

  constructor(store: Store, baseUrl: string, credential: () => Promise<string>) {
    this.store = store;
    this.baseUrl = baseUrl;
    this.credential = credential;
  }

  /** Emergency: ask the gateway to offset an urgent air shipment, the moment it's booked. */
  async emergency(shipmentId: string, item: string): Promise<void> {
    this.store.say('agent', `URGENT ${shipmentId} · ${item}. Air charter booked: offset it now.`, { cls: 'h' });
    const res = await this.post('/v1/offsets/emergency', await this.credential(), randomUUID(), { shipmentId });
    if (!res.ok) this.store.say('agent', `Offset not completed: ${res.body.error?.message ?? res.status}`, { cls: 'no' });
  }

  async runAll(jobs: JobSpec[]): Promise<void> {
    for (const job of jobs) {
      if (this.store.jobs.has(job.id)) continue;
      await this.run(job);
      await sleep(config.demo.paceMs);
    }
  }

  async run(job: JobSpec): Promise<void> {
    const s = this.store;
    const say = (text: string, extra = {}) => s.say('agent', text, { jobId: job.id, ...extra });
    s.setJob(job.id, { status: 'running' });
    say(`${job.id} · ${job.name} · ${job.note}`, { cls: 'h' });
    await sleep(config.demo.paceMs);

    const token = await this.credential();

    // 1. Quote: pay a fraction of a cent for the carbon-aware plan.
    const quoteRes = await this.post('/v1/quotes', token, randomUUID(), {
      job: { id: job.id, name: job.name, gpuh: job.gpuh, flex: job.flex, zones: job.zones },
      prompt: job.prompt,
    });
    if (!quoteRes.ok) {
      say(`Stopped: ${quoteRes.body.error?.message ?? quoteRes.status}`, { cls: 'no' });
      if (!s.jobs.get(job.id) || s.jobs.get(job.id)?.status === 'running') s.setJob(job.id, { status: 'ref' });
      return;
    }
    const q = quoteRes.body.quote;
    await sleep(config.demo.paceMs);
    say(`Budget-only option: ${q.baseline.zone} now · ${q.baseline.intensity.toFixed(0)} g/kWh · ${q.baseline.kg.toFixed(1)} kg`, { amount: `$${q.baseline.price.toFixed(2)}` });
    const moved = [q.pick.zone !== q.baseline.zone && `→ ${s.scenario.zones[q.pick.zone].name}`, q.pick.offset > 0 && `→ ${hh(q.pick.hour)}`].filter(Boolean).join(', ');
    say(`Quote: ${q.pick.zone} @ ${hh(q.pick.hour)} · ${q.pick.intensity.toFixed(0)} g/kWh · ${q.pick.kg.toFixed(1)} kg ${moved ? `(${moved})` : ''} · green premium +$${q.pick.premium.toFixed(2)}`, { amount: `$${q.pick.price.toFixed(2)}` });
    await sleep(config.demo.paceMs);

    // 2. Book it. The gateway may hold this request open while the owner decides.
    //    One Idempotency-Key per booking, so a retry continues the same call instead of paying twice.
    const bookRes = await this.post('/v1/bookings', token, randomUUID(), { quoteId: q.id });
    if (!bookRes.ok) say(`Not booked: ${bookRes.body.error?.message ?? bookRes.status}`, { cls: 'no' });
  }

  private async post(path: string, token: string, idempotencyKey: string, body: unknown) {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }
}
