/**
 * The GPU cloud the gateway books capacity on. Mocked: in production this is a call to the
 * cloud provider's reservation API (or a scheduler such as Slurm or Kubernetes).
 *
 * The gateway calls `book` only AFTER SolvaPay has authorized the spend, and reports the cost it
 * returns back to SolvaPay so the call settles at the real price.
 */

import { randomUUID } from 'node:crypto';

export interface Booking {
  bookingId: string;
  /** HTTP-style status. 400 and above means "not booked", and SolvaPay then charges nothing. */
  status: number;
  /** USD actually charged by the cloud. */
  cost: number;
}

export interface GpuCloud {
  book(input: { zone: string; startOffsetHours: number; gpuHours: number; pricePerGpuHour: number }): Promise<Booking>;
}

export const mockCloud: GpuCloud = {
  async book({ gpuHours, pricePerGpuHour }) {
    return { bookingId: `bkg_${randomUUID().slice(0, 8)}`, status: 200, cost: Math.round(gpuHours * pricePerGpuHour * 100) / 100 };
  },
};
