/**
 * Wires up the SolvaPay SDK (@solvapay/agents). The only file that knows which mode we're in.
 *
 *   DEMO    → SandboxSpendPolicy (local stand-in) + agent tokens signed with a local test key
 *   SANDBOX → createSolvaPayAgentClient (the real SolvaPay API) + tokens checked against
 *             SolvaPay's published keys (JWKS)
 *
 * Either way the rest of the gateway gets the same three things:
 *   - `agentLayer` : who is calling (verifies the agent's token or key)
 *   - `gate`       : authorize a paid call before it runs, then finish it at its real cost
 *   - `credential` : what the built-in demo agent presents as its bearer token
 */

import { createLocalJWKSet, createRemoteJWKSet } from 'jose';
import {
  createAgentCalls,
  createAgentKeyVerifier,
  createAgentLayer,
  createAgentTokenVerifier,
  createSolvaPayAgentClient,
  secretKeyEnvironment,
} from '@solvapay/agents';
import type { AgentLayer, Logger, SolvaPayAgentClient } from '@solvapay/agents';
import { createAgentHttpGate } from '@solvapay/agents/http';
import { config, type Mode } from '../config.ts';
import { SandboxSpendPolicy } from './sandboxSpendPolicy.ts';
import type { Approvals } from '../services/approvals.ts';
import type { Store } from '../services/store.ts';

export interface Payments {
  mode: Mode;
  agentLayer: AgentLayer;
  gate: ReturnType<typeof createAgentHttpGate>;
  /** Only in demo mode: the stand-in, so the dashboard can show and edit its limits. */
  standIn?: SandboxSpendPolicy;
  /** Bearer credential for the built-in demo agent. */
  credential: () => Promise<string>;
  /** requestIds for which SolvaPay said "waiting for the owner" (to label decisions "asked you"). */
  asked: Set<string>;
}

export interface PaymentsDeps {
  store: Store;
  approvals: Approvals;
  /** Tests can inject the SDK's FakeAgentApi here. */
  client?: SolvaPayAgentClient;
}

// The demo agent's identity. In sandbox mode these come from SolvaPay instead.
export const DEMO_AGENT = { agentRef: 'agt_pitwall_7f3k2q', principalRef: 'ppl_mclaren01', name: 'pitwall-agent', harness: 'Claude Code' };

export async function createPayments(deps: PaymentsDeps): Promise<Payments> {
  const asked = new Set<string>();

  // SDK log events go to stdout as JSON lines and into the dashboard's call log.
  const log: Logger = {
    info(event, fields = {}) {
      console.log(JSON.stringify({ event, ...fields }));
      if (event === 'call.waiting' && typeof fields.requestId === 'string' && !asked.has(fields.requestId)) {
        asked.add(fields.requestId);
        deps.store.say('solvapay', `Over a spend limit. Waiting for the owner to approve${config.mode === 'sandbox' ? ' in SolvaPay' : ''}…`, { cls: 'pay' });
      }
    },
    error(event, fields = {}) {
      console.error(JSON.stringify({ event, ...fields }));
      deps.store.say('solvapay', `SDK error: ${event} ${fields.error ?? ''}`, { cls: 'no' });
    },
  };

  if (config.mode === 'sandbox') {
    const { secretKey, providerRef, issuer, apiBaseUrl, demoAgentKey, maxApprovalWaitSeconds } = config.solvapay;
    const client = deps.client ?? createSolvaPayAgentClient({ apiBaseUrl, secretKey });
    const environment = secretKeyEnvironment(secretKey);
    const agentLayer = createAgentLayer({
      verifyAgentToken: createAgentTokenVerifier({ issuer, providerRef, environment, keys: createRemoteJWKSet(new URL(`${issuer}/jwks.json`)) }),
      verifyAgentKey: createAgentKeyVerifier({ client, environment }),
    });
    const calls = createAgentCalls({ client, maxWaitSeconds: maxApprovalWaitSeconds, log });
    return {
      mode: 'sandbox',
      agentLayer,
      gate: createAgentHttpGate({ agentLayer, calls, log }),
      asked,
      credential: async () => {
        if (!demoAgentKey) throw new Error('Set SOLVAPAY_DEMO_AGENT_KEY to run the demo agent against SolvaPay sandbox');
        return demoAgentKey;
      },
    };
  }

  // DEMO: the SDK's own test helpers sign agent tokens with a throwaway local key.
  // Imported lazily so production never loads test code.
  const testing = await import('@solvapay/agents/testing');
  const { privateKey, publicJwk } = await testing.agentKeys();
  const standIn = new SandboxSpendPolicy(deps.store.scenario.budget, deps.approvals);
  const client = deps.client ?? standIn;
  const agentLayer = createAgentLayer({
    verifyAgentToken: createAgentTokenVerifier({
      issuer: testing.ISSUER,
      providerRef: testing.PROVIDER,
      environment: 'sandbox',
      keys: createLocalJWKSet({ keys: [publicJwk] }),
    }),
  });
  const calls = createAgentCalls({ client, maxWaitSeconds: config.solvapay.maxApprovalWaitSeconds, log });

  return {
    mode: 'demo',
    agentLayer,
    gate: createAgentHttpGate({ agentLayer, calls, log }),
    standIn: deps.client ? undefined : standIn,
    asked,
    // promptExcerpt: true = the owner lets SolvaPay read the end of the prompt (needed for the purpose check).
    credential: () => testing.signAgentToken(privateKey, { sub: DEMO_AGENT.agentRef, principal: DEMO_AGENT.principalRef, promptExcerpt: true, expiresIn: '1h' }),
  };
}
