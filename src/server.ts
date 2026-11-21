/**
 * Entry point. Builds the app from its parts and serves three things on one port:
 *
 *   /, /policies, /jobs, /emergency, /log, /statement, /tokens
 *                the dashboard pages (public/*.html, sharing public/app.js and app.css)
 *   /v1/*        the agent-facing gateway (agents call this; SolvaPay-paid)
 *   /api/*       the owner-facing dashboard API
 *
 * `createApp` takes optional overrides so tests can swap SolvaPay for the SDK's FakeAgentApi.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { SolvaPayAgentClient } from '@solvapay/agents';
import { config } from './config.ts';
import { EventBus } from './services/events.ts';
import { Approvals } from './services/approvals.ts';
import { Store } from './services/store.ts';
import { mockCloud, type GpuCloud } from './services/cloud.ts';
import { mockEctRegistry } from './services/ectRegistry.ts';
import { createPayments } from './payments/solvapay.ts';
import { createAgentApi } from './http/agentApi.ts';
import { createDashboardApi } from './http/dashboardApi.ts';
import { DemoAgent } from './demo/demoAgent.ts';

const MAX_BODY = 64 * 1024;

/**
 * The dashboard's pages and assets. An explicit allow-list (URL → file in public/), so a crafted
 * path like /../.env can never reach the disk.
 */
const HTML = 'text/html; charset=utf-8';
const STATIC: Record<string, { name: string; type: string }> = {
  '/': { name: 'index.html', type: HTML },              // Overview
  '/policies': { name: 'policies.html', type: HTML },   // Spend policies
  '/jobs': { name: 'jobs.html', type: HTML },           // Job queue
  '/log': { name: 'log.html', type: HTML },             // Call log
  '/statement': { name: 'statement.html', type: HTML }, // Statement
  '/tokens': { name: 'tokens.html', type: HTML },       // Carbon tokens (ECTs)
  '/emergency': { name: 'emergency.html', type: HTML }, // Emergency freight
  '/app.css': { name: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { name: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/favicon.svg': { name: 'favicon.svg', type: 'image/svg+xml' },
  '/pages/overview.js': { name: 'pages/overview.js', type: 'text/javascript; charset=utf-8' },
  '/pages/policies.js': { name: 'pages/policies.js', type: 'text/javascript; charset=utf-8' },
  '/pages/jobs.js': { name: 'pages/jobs.js', type: 'text/javascript; charset=utf-8' },
  '/pages/log.js': { name: 'pages/log.js', type: 'text/javascript; charset=utf-8' },
  '/pages/statement.js': { name: 'pages/statement.js', type: 'text/javascript; charset=utf-8' },
  '/pages/tokens.js': { name: 'pages/tokens.js', type: 'text/javascript; charset=utf-8' },
  '/pages/emergency.js': { name: 'pages/emergency.js', type: 'text/javascript; charset=utf-8' },
};

export async function createApp(overrides: { client?: SolvaPayAgentClient; cloud?: GpuCloud } = {}) {
  const bus = new EventBus();
  const store = new Store(bus);
  const approvals = new Approvals(bus);
  const payments = await createPayments({ store, approvals, client: overrides.client });
  const ects = mockEctRegistry();
  const agentApi = createAgentApi({ store, approvals, payments, cloud: overrides.cloud ?? mockCloud, ects });

  // The demo agent calls the gateway over HTTP; its address is filled in by listen().
  const agent = new DemoAgent(store, '', payments.credential);
  const dashboard = createDashboardApi({ store, approvals, payments, bus, agent, ects });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      const file = req.method === 'GET' ? STATIC[path] : undefined;
      if (file) {
        res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-cache' });
        res.end(await readFile(fileURLToPath(new URL(`../public/${file.name}`, import.meta.url))));
        return;
      }
      if (req.method === 'GET' && path === '/api/events') return dashboard.events(res);

      const body = req.method === 'GET' ? {} : await readJson(req);
      if (body === null) return send(res, Response.json({ error: { type: 'invalid_json' } }, { status: 400 }));

      if (path.startsWith('/v1/') && req.method === 'POST') {
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableFinished) ac.abort(); }); // agent hung up
        return send(res, await agentApi({
          path,
          body,
          presentedKey: (req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''),
          requestId: String(req.headers['idempotency-key'] ?? randomUUID()),
          signal: ac.signal,
        }));
      }
      if (path.startsWith('/api/')) return send(res, await dashboard.handle(req.method ?? 'GET', path, body));

      send(res, new Response('Not found', { status: 404 }));
    } catch (err) {
      console.error('request.failed', err);
      if (!res.headersSent) send(res, Response.json({ error: { type: 'internal' } }, { status: 500 }));
    }
  });

  return {
    server, store, approvals, payments, bus,
    async listen(port = config.port, host = config.host) {
      await new Promise<void>(r => server.listen(port, host, r));
      const addr = server.address() as AddressInfo;
      agent.baseUrl = `http://${host}:${addr.port}`;
      return agent.baseUrl;
    },
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Writes a fetch-style Response (what the SDK and our handlers return) to Node's response. */
async function send(res: ServerResponse, response: Response): Promise<void> {
  if (res.destroyed) return;
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

// Run directly (npm start), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const url = await app.listen();
  console.log(`SolvaGreen gateway on ${url}  ·  mode: ${app.payments.mode.toUpperCase()}${app.payments.mode === 'demo' ? ' (local SolvaPay stand-in, mock carbon unless keys set)' : ' (SolvaPay sandbox API)'}`);
}
