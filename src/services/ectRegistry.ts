/**
 * The ECT (Emission Carbon Token) registry the gateway buys offsets from. Mocked.
 *
 * 1 ECT offsets 1 kgCO2e. Every purchase is a "lot" with a serial-number range, and is retired
 * immediately (retired = used up against our emissions, so it can never be resold or counted twice).
 * In production this would be a call to a real registry or a tokenised-credit marketplace.
 *
 * The gateway calls `buy` only AFTER SolvaPay has authorized the purchase, and reports the cost
 * back to SolvaPay so the call settles at the real price.
 */

import { randomUUID } from 'node:crypto';

export interface EctLot {
  lotId: string;
  /** First and last serial number of the tokens in this lot, e.g. ECT-2026-000001. */
  serialFrom: string;
  serialTo: string;
  tokens: number;
  pricePerToken: number;
  cost: number;
  status: 'retired';
  /** What the lot offsets. */
  jobId: string;
  jobName: string;
  zone: string;
  kgOffset: number;
  /** SolvaPay's reference for the payment. */
  callRef: string;
  ts: string;
}

export interface EctRegistry {
  buy(input: { tokens: number; pricePerToken: number }): Promise<{ status: number; lotId: string; serialFrom: string; serialTo: string; cost: number }>;
  reset(): void;
}

const serial = (n: number) => `ECT-2026-${String(n).padStart(6, '0')}`;

export function mockEctRegistry(): EctRegistry {
  let next = 1;
  return {
    async buy({ tokens, pricePerToken }) {
      const from = next;
      next += tokens;
      return {
        status: 200,
        lotId: `lot_${randomUUID().slice(0, 8)}`,
        serialFrom: serial(from),
        serialTo: serial(from + tokens - 1),
        cost: Math.round(tokens * pricePerToken * 10000) / 10000,
      };
    },
    reset() {
      next = 1;
    },
  };
}
