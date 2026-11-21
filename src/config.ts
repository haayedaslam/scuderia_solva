/**
 * Runtime configuration, read once from environment variables (see .env.example).
 *
 * The one decision that matters here is `mode`:
 *   - 'demo'    : no SolvaPay key set. A local stand-in plays SolvaPay's part, so the whole
 *                 flow runs offline for a hackathon demo.
 *   - 'sandbox' : SOLVAPAY_SECRET_KEY is set. Budget checks, approvals and settlement go to
 *                 the real SolvaPay API (test money). The gateway code is identical in both modes.
 */

const env = process.env;

export type Mode = 'demo' | 'sandbox';

export const config = {
  port: Number(env.PORT ?? 8000),
  host: env.HOST ?? '127.0.0.1',
  mode: (env.SOLVAPAY_SECRET_KEY ? 'sandbox' : 'demo') as Mode,

  solvapay: {
    apiBaseUrl: env.SOLVAPAY_API_BASE_URL ?? 'https://api.solvapay.com',
    secretKey: env.SOLVAPAY_SECRET_KEY ?? '',
    providerRef: env.SOLVAPAY_PROVIDER_REF ?? '',
    issuer: 'https://api.solvapay.com/v1/agent',
    demoAgentKey: env.SOLVAPAY_DEMO_AGENT_KEY ?? '',
    // How long a paid call may wait for the owner to approve, in seconds.
    // SolvaPay holds each authorize request for at most 55 s; the SDK chains requests up to this.
    maxApprovalWaitSeconds: 300,
  },

  carbon: {
    electricityMapsKey: env.ELECTRICITY_MAPS_API_KEY ?? '',
    electricityMapsBaseUrl: env.ELECTRICITY_MAPS_BASE_URL ?? 'https://api.electricitymap.org/v3',
    wattTimeUser: env.WATTTIME_USERNAME ?? '',
    wattTimePassword: env.WATTTIME_PASSWORD ?? '',
  },

  demo: {
    // Pause between agent steps so a live audience can follow the log.
    // Read on each use, so tests can set DEMO_PACE_MS=0 after this module has loaded.
    get paceMs() { return Number(process.env.DEMO_PACE_MS ?? 350); },
    // The mock world's clock: Friday 20 Nov 2026, 08:00, qualifying day at the Las Vegas GP.
    date: '2026-11-20',
    startHour: 8,
  },

  dataDir: env.DATA_DIR ?? 'data',
};
