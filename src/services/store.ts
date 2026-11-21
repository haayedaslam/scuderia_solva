/**
 * Application state: the active scenario, the owner's carbon and green-premium policies, issued
 * quotes, the statement (ledger), job outcomes, ECT holdings and the call log.
 *
 * Kept in memory for the hackathon. Every statement row is also appended to
 * data/ledger.ndjson, so the statement survives a restart. A production version would put
 * all of this in Postgres, keyed by the SolvaPay principal (ppl_…) of each account.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { SCENARIOS, type JobSpec, type Scenario, type ScenarioKey } from '../domain/scenarios.ts';
import type { Plan, Slot } from '../domain/planner.ts';
import type { EventBus, LogLine } from './events.ts';
import type { EctLot } from './ectRegistry.ts';
import type { EmissionsCalc, ScoredProject, Shipment } from '../domain/freight.ts';

/** Progress of the emergency-freight offset, step by step, for the Emergency freight page. */
export interface EmergencyState {
  status: 'idle' | 'calculating' | 'checking' | 'paying' | 'done' | 'stopped';
  shipment: Shipment;
  triggeredAt?: string;
  calc?: EmissionsCalc;
  feedSource?: string;
  candidates?: ScoredProject[];
  chosen?: ScoredProject | null;
  cost?: number;
  gates?: { budget?: { pass: boolean; detail: string }; quality?: { pass: boolean; detail: string }; autoExecuted?: boolean };
  certificate?: Record<string, string | number>;
  error?: string;
}

/** A priced, carbon-checked offer the gateway issued. `book` only accepts quotes it issued itself. */
export interface Quote {
  id: string;
  jobId: string;
  jobName: string;
  gpuh: number;
  /** The account the quote was issued to. Another agent's account can't book it. */
  principalRef: string;
  agentRef: string;
  prompt: string;
  plan: Plan;
  carbonSource: string;
  expiresAt: number;
  booked: boolean;
}

export type JobStatus = 'running' | 'auto' | 'appr' | 'dec' | 'ref';

export interface JobOutcome {
  status: JobStatus;
  pick?: Slot;
  baseline?: Slot;
}

export interface LedgerRow {
  id: string;
  ts: string;
  hour: number;
  merchant: string;
  item: string;
  amount: number;
  intensity: number | null;
  kg: number | null;
  decision: { cls: 'ok' | 'ask' | 'no' | 'meter'; txt: string };
  jobId: string;
  /** SolvaPay's reference for the paid call (absent when SolvaPay was never asked or refused). */
  callRef?: string;
  /** The GPU cloud's booking reference, for booked jobs. */
  bookingId?: string;
}

export class Store {
  scenario: Scenario = SCENARIOS.lv;
  /** The owner's carbon cap in g/kWh. A SolvaGreen policy: SolvaPay has no notion of carbon. */
  carbonCap = SCENARIOS.lv.defaultCap;
  /** The agent's request queue: the scenario's scripted jobs, plus any generated ones. */
  queue: JobSpec[] = [...SCENARIOS.lv.jobs];
  /** How many batches of requests have been generated since the last reset (seeds the generator). */
  generatedBatches = 0;
  quotes = new Map<string, Quote>();
  jobs = new Map<string, JobOutcome>();
  ledger: LedgerRow[] = [];
  log: LogLine[] = [];
  /** Total paid for carbon quotes. */
  fees = 0;
  /** The owner's daily limit on the cost of going green (USD). A SolvaGreen policy. */
  greenPremiumLimit = SCENARIOS.lv.greenPremiumLimit;
  /** Minimum carbon-credit quality score (0–100). A SolvaGreen policy the owner can change. */
  qualityBar = SCENARIOS.lv.qualityBar;
  emergency: EmergencyState = { status: 'idle', shipment: SCENARIOS.lv.emergency };
  /** Retirement certificates issued so far (numbers them). */
  certificates = 0;
  /** Emission Carbon Tokens: auto-buy switch and every lot bought (each lot is retired on purchase). */
  ect: { autoBuy: boolean; lots: EctLot[] } = { autoBuy: true, lots: [] };
  /** True while the demo agent is running, so the dashboard can lock its buttons. */
  busy = false;

  private bus: EventBus;
  private startedAt = Date.now();

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  reset(key: ScenarioKey = this.scenario.key): void {
    this.scenario = SCENARIOS[key];
    this.carbonCap = this.scenario.defaultCap;
    this.queue = [...this.scenario.jobs];
    this.generatedBatches = 0;
    this.quotes.clear();
    this.jobs.clear();
    this.ledger = [];
    this.log = [];
    this.fees = 0;
    this.greenPremiumLimit = this.scenario.greenPremiumLimit;
    this.qualityBar = this.scenario.qualityBar;
    this.emergency = { status: 'idle', shipment: this.scenario.emergency };
    this.certificates = 0;
    this.ect = { autoBuy: true, lots: [] };
    this.startedAt = Date.now();
    this.changed();
  }

  /** Total paid for ECTs. */
  get ectSpent(): number {
    return this.ect.lots.reduce((sum, l) => sum + l.cost, 0);
  }

  /**
   * The cost of going green so far today: what the booked jobs cost on top of the budget-only
   * choice, plus carbon-data fees, plus ECTs. The green-premium limit is checked against this.
   */
  get premiumSpent(): number {
    let extra = 0;
    for (const j of this.jobs.values()) if (j.pick && j.baseline) extra += j.pick.price - j.baseline.price;
    return extra + this.fees + this.ectSpent;
  }

  /** The demo world's clock: Friday 20 Nov 2026 (Las Vegas GP qualifying day), 08:00, plus real time elapsed since reset. */
  now(): Date {
    const base = Date.UTC(2026, 10, 20, config.demo.startHour); // Friday 20 Nov 2026, qualifying day
    return new Date(base + (Date.now() - this.startedAt));
  }

  say(source: LogLine['source'], text: string, extra: Partial<LogLine> = {}): void {
    const line: LogLine = { at: this.now().toISOString().slice(11, 19), source, text, ...extra };
    this.log.push(line);
    if (this.log.length > 500) this.log.shift();
    this.bus.publish({ type: 'log', line });
  }

  setJob(jobId: string, outcome: JobOutcome): void {
    this.jobs.set(jobId, outcome);
    this.changed();
  }

  addLedger(row: Omit<LedgerRow, 'id' | 'ts'>): LedgerRow {
    const full: LedgerRow = { ...row, id: `txn_${randomUUID().slice(0, 8)}`, ts: this.now().toISOString() };
    this.ledger.push(full);
    void persist(full);
    this.changed();
    return full;
  }

  changed(): void {
    this.bus.publish({ type: 'changed' });
  }
}

/** Append-only statement file. Failures are logged, never thrown: the payment already happened. */
async function persist(row: LedgerRow): Promise<void> {
  try {
    await mkdir(config.dataDir, { recursive: true });
    await appendFile(join(config.dataDir, 'ledger.ndjson'), JSON.stringify(row) + '\n');
  } catch (err) {
    console.error('ledger.persist_failed', err);
  }
}
