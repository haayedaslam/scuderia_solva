/**
 * Emergency freight: what an urgent air shipment emits, and which carbon credits are good enough
 * to offset it. Pure functions, no I/O, every assumption named so it can be challenged.
 *
 * 1. EMISSIONS (dedicated air charter, fuel-based method)
 *      distance  = great-circle(origin, destination) × 1.05 routing factor
 *      flight h  = distance ÷ cruise speed + 0.5 h (taxi, climb, approach)
 *      fuel kg   = flight h × fuel burn per hour (aircraft class assumption)
 *      tCO2      = fuel kg × 3.16 kg CO2 per kg jet fuel (ICAO combustion factor) ÷ 1000
 *    The whole aircraft is allocated to the shipment, because it was chartered for this part alone.
 *    Not included: non-CO2 effects of flying at altitude (contrails, NOx), upstream fuel production,
 *    and the short van legs at each end.
 *
 * 2. QUALITY (SolvaGreen's own rubric, scored 0–100; Carbonmark supplies the facts, not the rating)
 *      Registry   0–30   major independent standards score highest
 *      Type       0–40   durable removals > nature-based removals > avoidance; old renewables score 0
 *                        (grid-connected renewables are widely seen as not additional today)
 *      Vintage    0–30   recent credits score highest
 *    A project must also have enough credits for sale to cover the whole shipment.
 *    Of the projects that clear the owner's quality bar, the cheapest is chosen.
 */

export interface Airport { code: string; name: string; lat: number; lon: number }

export interface Shipment {
  id: string;
  item: string;
  reason: string;
  weightKg: number;
  from: Airport;
  to: Airport;
  aircraft: { label: string; fuelKgPerHour: number; cruiseKmh: number };
  deadlineHours: number;
}

export interface EmissionsCalc {
  greatCircleKm: number;
  routedKm: number;
  flightHours: number;
  fuelKg: number;
  tCO2: number;
  /** Credits to buy: one per tonne, rounded up so the shipment is fully covered. */
  credits: number;
  assumptions: string[];
}

export const JET_FUEL_KG_CO2_PER_KG = 3.16;
const ROUTING_FACTOR = 1.05;
const TAXI_CLIMB_HOURS = 0.5;

export function greatCircleKm(a: Airport, b: Airport): number {
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function charterEmissions(s: Shipment): EmissionsCalc {
  const gc = greatCircleKm(s.from, s.to);
  const routed = gc * ROUTING_FACTOR;
  const hours = routed / s.aircraft.cruiseKmh + TAXI_CLIMB_HOURS;
  const fuel = hours * s.aircraft.fuelKgPerHour;
  const tCO2 = (fuel * JET_FUEL_KG_CO2_PER_KG) / 1000;
  return {
    greatCircleKm: gc,
    routedKm: routed,
    flightHours: hours,
    fuelKg: fuel,
    tCO2,
    credits: Math.ceil(tCO2 - 1e-9),
    assumptions: [
      `${s.from.code} → ${s.to.code} great-circle ${Math.round(gc).toLocaleString('en-US')} km × ${ROUTING_FACTOR} routing`,
      `${s.aircraft.label}: ${s.aircraft.cruiseKmh} km/h cruise, ${s.aircraft.fuelKgPerHour.toLocaleString('en-US')} kg fuel/h, +${TAXI_CLIMB_HOURS} h taxi/climb`,
      `${JET_FUEL_KG_CO2_PER_KG} kg CO₂ per kg jet fuel (ICAO combustion factor)`,
      'Whole aircraft allocated to this part (dedicated charter)',
      'Excludes non-CO₂ altitude effects, fuel production and van legs',
    ],
  };
}

// ── Quality rubric ─────────────────────────────────────────────────────────

export interface CarbonProject {
  key: string;
  name: string;
  registry: string;
  country: string;
  vintages: string[];
  pricePerTonne: number;
  methodologyId: string | null;
  methodology: string | null;
  category: string | null;
  supplyTonnes: number;
}

export interface ScoredProject extends CarbonProject {
  vintage: number | null;
  type: 'Durable removal' | 'Nature-based removal' | 'Avoidance (forest)' | 'Avoidance (agriculture)' | 'Avoidance (renewables)' | 'Other';
  score: { registry: number; type: number; vintage: number; total: number };
  tier: 'A' | 'B' | 'C';
  /** Why it was excluded or failed, if it did. */
  verdict: 'chosen' | 'pass' | 'below bar' | 'not enough supply';
}

const REGISTRY_POINTS: Record<string, number> = { VCS: 30, GS: 30, PUR: 30, ISO: 30, ICR: 15 };
export const REGISTRY_NAMES: Record<string, string> = {
  VCS: 'Verra (VCS)', GS: 'Gold Standard', PUR: 'Puro.earth', ISO: 'Isometric', ICR: 'Intl Carbon Registry', UCR: 'Universal Carbon Registry',
};

function creditType(p: CarbonProject): ScoredProject['type'] {
  const m = `${p.methodologyId ?? ''} ${p.methodology ?? ''} ${p.name}`.toUpperCase();
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('biochar') || m.includes('BIOCHAR')) return 'Durable removal';
  if (m.includes('REDD')) return 'Avoidance (forest)';
  if (c.includes('blue carbon') || m.includes('AR-') || m.includes('REFOREST') || m.includes('AFFOREST')) return 'Nature-based removal';
  if (c.includes('agriculture')) return 'Avoidance (agriculture)';
  if (c.includes('renewable') || m.includes('ACM0002') || m.includes('AMS-I.D') || m.includes('HYDRO') || m.includes('WIND') || m.includes('SOLAR')) return 'Avoidance (renewables)';
  if (c.includes('forestry')) return 'Nature-based removal';
  return 'Other';
}

const TYPE_POINTS: Record<ScoredProject['type'], number> = {
  'Durable removal': 40, 'Nature-based removal': 30, 'Avoidance (agriculture)': 15, 'Avoidance (forest)': 10, 'Avoidance (renewables)': 0, Other: 5,
};

function latestVintage(p: CarbonProject): number | null {
  const years = p.vintages.map(v => Number(String(v).slice(0, 4))).filter(y => y > 1990 && y < 2100);
  return years.length ? Math.max(...years) : null;
}

const vintagePoints = (y: number | null) => (y == null ? 0 : y >= 2022 ? 30 : y >= 2020 ? 20 : y >= 2018 ? 10 : 0);

export function scoreProject(p: CarbonProject): Omit<ScoredProject, 'verdict'> {
  const type = creditType(p);
  const vintage = latestVintage(p);
  const s = { registry: REGISTRY_POINTS[p.registry] ?? 5, type: TYPE_POINTS[type], vintage: vintagePoints(vintage) };
  const total = s.registry + s.type + s.vintage;
  return { ...p, vintage, type, score: { ...s, total }, tier: total >= 80 ? 'A' : total >= 70 ? 'B' : 'C' };
}

/** Scores every project and picks the cheapest one that clears the bar and can cover the credits needed. */
export function chooseProject(projects: CarbonProject[], credits: number, qualityBar: number): { candidates: ScoredProject[]; chosen: ScoredProject | null } {
  const scored = projects.map(scoreProject).map(p => ({
    ...p,
    verdict: (p.supplyTonnes < credits ? 'not enough supply' : p.score.total >= qualityBar ? 'pass' : 'below bar') as ScoredProject['verdict'],
  }));
  const passing = scored.filter(p => p.verdict === 'pass').sort((a, b) => a.pricePerTonne - b.pricePerTonne || b.score.total - a.score.total);
  const chosen = passing[0] ?? null;
  if (chosen) chosen.verdict = 'chosen';
  // Show the chosen one first, then the rest by score, so the screen reads top-down.
  const candidates = [...scored].sort((a, b) => Number(b === chosen) - Number(a === chosen) || b.score.total - a.score.total || a.pricePerTonne - b.pricePerTonne);
  return { candidates, chosen };
}
