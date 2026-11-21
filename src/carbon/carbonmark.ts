/**
 * Carbonmark project data: which carbon-credit projects have credits for sale, at what price.
 *
 * By default the demo reads a snapshot fetched from Carbonmark's public API
 * (src/data/carbonmark-snapshot.json), so the pitch can't change under us mid-demo.
 * Set CARBONMARK_LIVE=1 to read the live API instead (falls back to the snapshot on any error).
 *
 * Carbonmark supplies the facts (registry, methodology, vintage, price, supply).
 * The quality score is SolvaGreen's own (src/domain/freight.ts).
 */

import { readFile } from 'node:fs/promises';
import type { CarbonProject } from '../domain/freight.ts';

const SNAPSHOT = new URL('../data/carbonmark-snapshot.json', import.meta.url);
const LIVE_URL = 'https://api.carbonmark.com/carbonProjects?minSupply=1&limit=300';

export interface ProjectFeed { projects: CarbonProject[]; source: string; live: boolean }

export async function loadProjects(): Promise<ProjectFeed> {
  if (process.env.CARBONMARK_LIVE === '1') {
    try {
      const res = await fetch(LIVE_URL, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Carbonmark ${res.status}`);
      const body = (await res.json()) as { items: any[] };
      const projects: CarbonProject[] = body.items
        .map(p => {
          const m = (p.methodologies ?? [])[0] ?? {};
          return {
            key: p.key, name: p.name, registry: p.registry, country: p.country,
            vintages: (p.vintages ?? []).map(String), pricePerTonne: Number(p.price ?? 0),
            methodologyId: m.id ?? null, methodology: m.name ?? null, category: m.category ?? null,
            supplyTonnes: Number(p.stats?.totalListingsSupply ?? 0),
          };
        })
        .filter(p => p.supplyTonnes > 0);
      return { projects, source: 'Carbonmark API (live)', live: true };
    } catch (err) {
      console.error('carbonmark.live_failed', String(err));
    }
  }
  const snap = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as { fetchedAt: string; projects: CarbonProject[] };
  return { projects: snap.projects, source: `Carbonmark API snapshot · ${snap.fetchedAt}`, live: false };
}
