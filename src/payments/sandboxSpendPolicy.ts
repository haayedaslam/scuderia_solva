/**
 * DEMO MODE ONLY: a local stand-in for SolvaPay's agent-payments API.
 *
 * It implements the SDK's own `SolvaPayAgentClient` interface (verifyAgentKey, authorize,
 * complete, reportUsage), so the gateway talks to it through exactly the same SDK code paths
 * (`createAgentCalls`, `createAgentHttpGate`) it uses against the real SolvaPay. Switching to
 * the real thing is a config change, not a code change.
 *
 * It imitates what SolvaPay does on its side:
 *   - spend limits per call, per day and per month, checked at authorize
 *   - "waiting" while the owner decides on a request over a limit (approvals land on our dashboard)
 *   - a purpose check that refuses off-purpose buys with `deny` (SolvaPay uses a classifier; this is
 *     a keyword rule, clearly not production grade)
 *   - settlement at the cost reported on complete, with nothing charged for status >= 400
 */

import { randomUUID } from 'node:crypto';
import { AgentApiError } from '@solvapay/agents';
import type {
  AuthorizeInput,
  AuthorizeResponse,
  CompleteInput,
  CompleteResponse,
  SolvaPayAgentClient,
  UsageReport,
  UsageReportResponse,
  VerifiedAgentKey,
} from '@solvapay/agents';
import type { Approvals } from '../services/approvals.ts';

export interface SpendPolicy {
  perCall: number;
  perDay: number;
  perMonth: number;
  /** What the account had already spent this month before the demo started. */
  monthSpentBefore: number;
  /**
   * Per-merchant per-call limits, keyed by the start of the call's `item` (SolvaPay supports limits
   * "per agent, per merchant, per call, per day and per month"). Example: carbon credits for an
   * emergency shipment may cost more per call than a GPU job, without raising the GPU limit.
   */
  perMerchant?: Record<string, { label: string; perCall: number }>;
}

interface CallState {
  callRef: string;
  estimate: number;
  state: 'pending_approval' | 'held' | 'refused' | 'settled' | 'released';
  approvalId?: string;
  breaches: Breach[];
  refusal?: { reason: 'deny' | 'approval_declined' | 'approval_expired'; message: string };
}

type Breach = { limit: 'perCall' | 'perDay' | 'perMonth'; text: string; /** set when a merchant's own per-call limit was broken */ merchant?: string };

// Stand-in for SolvaPay's purpose classifier: catches the demo's injected instruction.
const OFF_PURPOSE = /ignore (all |any )?previous instructions|for a partner|transfer funds|gift card/i;

export class SandboxSpendPolicy implements SolvaPayAgentClient {
  policy: SpendPolicy;
  /** Settled spend today (USD). */
  spentToday = 0;

  private calls = new Map<string, CallState>(); // requestId → call
  private byRef = new Map<string, string>(); // callRef → requestId
  private approvals: Approvals;

  constructor(policy: SpendPolicy, approvals: Approvals) {
    this.policy = structuredClone(policy); // deep copy: raising a limit must never change the scenario's defaults
    this.approvals = approvals;
  }

  reset(policy: SpendPolicy): void {
    this.policy = structuredClone(policy);
    this.spentToday = 0;
    this.calls.clear();
    this.byRef.clear();
  }

  get spentThisMonth(): number {
    return this.policy.monthSpentBefore + this.spentToday;
  }

  async verifyAgentKey(_agentKey: string): Promise<VerifiedAgentKey> {
    // The demo agent uses a signed token, not an agent key.
    throw new AgentApiError('Agent keys are not used in demo mode', 401);
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResponse> {
    const estimate = Number(input.estimate.amount);
    let call = this.calls.get(input.requestId);

    // First time we see this requestId: run the checks. A repeat continues the same call (as SolvaPay does).
    if (!call) {
      call = { callRef: `call_${randomUUID().slice(0, 8)}`, estimate, state: 'held', breaches: [] };
      this.calls.set(input.requestId, call);
      this.byRef.set(call.callRef, input.requestId);

      if (input.promptExcerpt && OFF_PURPOSE.test(input.promptExcerpt)) {
        call.state = 'refused';
        call.refusal = { reason: 'deny', message: 'This purchase doesn’t fit pitwall-agent’s purpose (buy GPU-hours, carbon signals and ECT offsets for race-weekend engineering jobs). It looks like prompt injection.' };
      } else {
        call.breaches = this.breaches(estimate, input.item);
        if (call.breaches.length) {
          call.state = 'pending_approval';
          call.approvalId = this.approvals.request({
            kind: 'budget',
            title: 'Over a SolvaPay spend limit',
            amount: estimate,
            reasons: call.breaches.map(b => b.text),
            details: { Item: input.item ?? 'paid call', 'Request ID': input.requestId },
            canRaise: true,
          }).id;
          // Answer "waiting" straight away so the gateway (and the dashboard) know the owner was asked.
          return this.waiting(call);
        }
      }
    }

    if (call.state === 'pending_approval') {
      const approval = await this.approvals.wait(call.approvalId!, input.wait * 1000);
      if (approval.status === 'pending') return this.waiting(call);
      if (approval.status === 'expired') {
        call.state = 'refused';
        call.refusal = { reason: 'approval_expired', message: 'The approval request expired.' };
      } else if (approval.decision === 'decline') {
        call.state = 'refused';
        call.refusal = { reason: 'approval_declined', message: 'The owner declined this payment.' };
      } else {
        if (approval.decision === 'raise') this.raiseFor(call);
        call.state = 'held';
      }
    }

    if (call.state === 'refused') return { status: 'refused', callRef: call.callRef, reason: call.refusal!.reason, message: call.refusal!.message };
    return {
      status: 'allowed',
      callRef: call.callRef,
      reservation: { held: { amount: estimate.toFixed(2), currency: 'USD' }, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
    };
  }

  async complete(callRef: string, input: CompleteInput): Promise<CompleteResponse> {
    const requestId = this.byRef.get(callRef);
    const call = requestId ? this.calls.get(requestId) : undefined;
    if (!call) throw new AgentApiError(`Unknown call ${callRef}`, 404);
    if (call.state === 'settled' || call.state === 'released') throw new AgentApiError(`Call ${callRef} already completed`, 409);

    const charge = input.status < 400 ? Number(input.cost?.amount ?? call.estimate) : 0;
    call.state = charge > 0 ? 'settled' : 'released';
    this.spentToday += charge;
    return {
      callRef,
      settled: charge > 0,
      source: input.status >= 400 ? 'none' : input.cost ? 'reported' : 'provisional',
      amount: { amount: charge.toFixed(8), currency: 'USD' },
      duplicate: false,
    };
  }

  async reportUsage(report: UsageReport): Promise<UsageReportResponse> {
    return {
      reference: `urp_${randomUUID().slice(0, 8)}`,
      currency: 'USD',
      duplicate: false,
      results: report.calls.map(c => ({ callRef: c.callRef, result: 'matched' as const, reported: c.cost })),
      untagged: { total: '0', beforePolicy: '0', flagged: false },
    };
  }

  /** Which limits this payment would break. */
  private breaches(amount: number, item = ''): Breach[] {
    const p = this.policy;
    const out: Breach[] = [];
    // A merchant-specific per-call limit replaces the general one for that merchant's items.
    const merchantKey = Object.keys(p.perMerchant ?? {}).find(k => item.startsWith(k));
    const perCall = merchantKey ? p.perMerchant![merchantKey].perCall : p.perCall;
    const perCallName = merchantKey ? `${p.perMerchant![merchantKey].label} per-call limit` : 'per-call limit';
    if (amount > perCall) out.push({ limit: 'perCall', merchant: merchantKey, text: `$${amount.toFixed(2)} is over the $${perCall} ${perCallName}.` });
    else if (this.spentToday + amount > p.perDay) out.push({ limit: 'perDay', text: `It would take today's spend past the $${p.perDay} daily limit.` });
    else if (this.spentThisMonth + amount > p.perMonth) out.push({ limit: 'perMonth', text: `It would take this month past the $${p.perMonth} monthly limit.` });
    return out;
  }

  /** "Raise limit": lift exactly the limits this call broke, just enough for it to pass. */
  private raiseFor(call: CallState): void {
    for (const b of call.breaches) {
      if (b.limit === 'perCall' && b.merchant) this.policy.perMerchant![b.merchant].perCall = Math.ceil(call.estimate);
      else if (b.limit === 'perCall') this.policy.perCall = Math.ceil(call.estimate);
      if (b.limit === 'perDay') this.policy.perDay = Math.ceil(this.spentToday + call.estimate);
      if (b.limit === 'perMonth') this.policy.perMonth = Math.ceil(this.spentThisMonth + call.estimate);
    }
  }

  private waiting(call: CallState): AuthorizeResponse {
    return {
      status: 'waiting',
      callRef: call.callRef,
      message: 'Waiting for the owner to approve.',
      approval: { reference: call.approvalId!, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      retryAfterSeconds: 0.2,
    };
  }
}
