/**
 * Approval queue: requests that need the owner to say yes or no.
 *
 * Three kinds land here:
 *   - 'carbon' : SolvaGreen's own. The grid is over the cap and the job can't move. Always ours.
 *   - 'premium': SolvaGreen's own. Going green on this job would pass the daily cost-of-green limit.
 *   - 'budget' : over a SolvaPay spend limit. Only in DEMO mode, where the local stand-in plays
 *                SolvaPay. In sandbox/live mode the owner approves budget requests in SolvaPay's
 *                own app, and the gateway just waits for SolvaPay's answer.
 *
 * The code that needs an answer calls `wait()`, which resolves when the owner decides on the
 * dashboard (POST /api/approvals/:id) or when the timeout or the caller's abort signal fires.
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from './events.ts';

export type ApprovalKind = 'carbon' | 'premium' | 'budget';
export type Decision = 'approve' | 'decline' | 'raise';

export interface Approval {
  id: string;
  kind: ApprovalKind;
  jobId?: string;
  title: string;
  amount: number;
  reasons: string[];
  details: Record<string, string>;
  /** Offer "Raise limit"? Only for money limits (budget, green premium); the carbon cap is a policy decision, not a click. */
  canRaise: boolean;
  status: 'pending' | 'decided' | 'expired';
  decision?: Decision;
  createdAt: number;
}

export class Approvals {
  private items = new Map<string, Approval>();
  private waiters = new Map<string, Set<() => void>>();
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  request(input: Omit<Approval, 'id' | 'status' | 'createdAt'>): Approval {
    const approval: Approval = { ...input, id: `apr_${randomUUID().slice(0, 8)}`, status: 'pending', createdAt: Date.now() };
    this.items.set(approval.id, approval);
    this.bus.publish({ type: 'approval', id: approval.id });
    this.bus.publish({ type: 'changed' });
    return approval;
  }

  get(id: string): Approval | undefined {
    return this.items.get(id);
  }

  pending(): Approval[] {
    return [...this.items.values()].filter(a => a.status === 'pending');
  }

  /** Records the owner's decision. Returns false if the approval is unknown or already decided. */
  decide(id: string, decision: Decision): boolean {
    const a = this.items.get(id);
    if (!a || a.status !== 'pending') return false;
    if (decision === 'raise' && !a.canRaise) return false;
    a.status = 'decided';
    a.decision = decision;
    this.wake(id);
    this.bus.publish({ type: 'changed' });
    return true;
  }

  /** Resolves when decided, or after `timeoutMs` / on abort (the approval then stays pending). */
  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<Approval> {
    const a = this.items.get(id);
    if (!a) return Promise.reject(new Error(`Unknown approval ${id}`));
    if (a.status !== 'pending') return Promise.resolve(a);
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        this.waiters.get(id)?.delete(done);
        resolve(a);
      };
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener('abort', done, { once: true });
      if (!this.waiters.has(id)) this.waiters.set(id, new Set());
      this.waiters.get(id)!.add(done);
    });
  }

  /** Withdraws one open request (the agent stopped waiting for it). */
  cancel(id: string): void {
    const a = this.items.get(id);
    if (!a || a.status !== 'pending') return;
    a.status = 'expired';
    this.wake(id);
    this.bus.publish({ type: 'changed' });
  }

  /** Expires everything still open (used on reset so no agent waits forever). */
  clear(): void {
    for (const a of this.items.values()) if (a.status === 'pending') { a.status = 'expired'; this.wake(a.id); }
    this.items.clear();
  }

  private wake(id: string): void {
    for (const fn of this.waiters.get(id) ?? []) fn();
    this.waiters.delete(id);
  }
}
