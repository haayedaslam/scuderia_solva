/**
 * In-process event bus. Every component publishes what it did here; the dashboard
 * subscribes over Server-Sent Events (GET /api/events) and updates live.
 */

import { EventEmitter } from 'node:events';

export type AppEvent =
  | { type: 'log'; line: LogLine }
  | { type: 'changed' } // something in /api/state changed; the dashboard re-fetches it
  | { type: 'approval'; id: string };

export interface LogLine {
  at: string;
  /** Which component is speaking, so the call log shows who did what. */
  source: 'agent' | 'gateway' | 'solvapay';
  text: string;
  cls?: 'h' | 'ok' | 'no' | 'pay';
  amount?: string;
  jobId?: string;
}

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100); // one listener per open dashboard tab
  }

  publish(event: AppEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(fn: (event: AppEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
