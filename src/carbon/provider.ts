/**
 * Carbon data providers behind one interface.
 *
 * The planner only ever sees `HourlyForecast`, so swapping mock data for Electricity Maps or
 * WattTime changes nothing downstream. Each real adapter is used only when its credentials are
 * configured; otherwise the scenario falls back to the mock curves.
 */

import { config } from '../config.ts';
import type { Scenario } from '../domain/scenarios.ts';

export interface HourlyForecast {
  zone: string;
  /** Hour of day the first value is for (values[i] is startHour + i). */
  startHour: number;
  /** Grid intensity in gCO2/kWh, one value per hour. */
  values: number[];
  /** Where the numbers came from, shown on statement rows and the chart. */
  source: string;
  method: string;
  live: boolean;
}

export interface CarbonProvider {
  forecast(zone: string, hours: number): Promise<HourlyForecast>;
}

/** Mock provider: evaluates the scenario's curves on the demo clock (08:00). */
export function mockProvider(scenario: Scenario): CarbonProvider {
  return {
    async forecast(zone, hours) {
      const z = scenario.zones[zone];
      if (!z) throw new Error(`Unknown zone ${zone}`);
      const start = config.demo.startHour;
      const values = Array.from({ length: hours + 1 }, (_, i) => z.mockCurve(start + i));
      return { zone, startHour: start, values, source: `${scenario.source} (mock)`, method: scenario.method, live: false };
    },
  };
}

/**
 * Electricity Maps v3 forecast endpoint. Auth is an `auth-token` header.
 * Response: { zone, forecast: [{ carbonIntensity, datetime }] }.
 */
function electricityMapsProvider(): CarbonProvider {
  return {
    async forecast(zone, hours) {
      const url = `${config.carbon.electricityMapsBaseUrl}/carbon-intensity/forecast?zone=${encodeURIComponent(zone)}`;
      const res = await fetch(url, { headers: { 'auth-token': config.carbon.electricityMapsKey }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Electricity Maps ${res.status}`);
      const body = (await res.json()) as { forecast: { carbonIntensity: number; datetime: string }[] };
      const points = body.forecast.slice(0, hours + 1);
      return {
        zone,
        startHour: new Date(points[0].datetime).getUTCHours(),
        values: points.map(p => p.carbonIntensity),
        source: 'Electricity Maps',
        method: 'flow-traced, average',
        live: true,
      };
    },
  };
}

/**
 * WattTime v3. Log in with basic auth for a ~30 min bearer token, then read the MOER forecast.
 * MOER comes in lbs CO2/MWh at 5-minute steps; we convert to g/kWh and keep one point per hour.
 */
function wattTimeProvider(): CarbonProvider {
  let token: { value: string; expires: number } | null = null;
  const LBS_PER_MWH_TO_G_PER_KWH = 0.453592;

  async function bearer(): Promise<string> {
    if (token && token.expires > Date.now()) return token.value;
    const basic = Buffer.from(`${config.carbon.wattTimeUser}:${config.carbon.wattTimePassword}`).toString('base64');
    const res = await fetch('https://api.watttime.org/login', { headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`WattTime login ${res.status}`);
    const { token: value } = (await res.json()) as { token: string };
    token = { value, expires: Date.now() + 25 * 60_000 };
    return value;
  }

  return {
    async forecast(zone, hours) {
      const url = `https://api.watttime.org/v3/forecast?region=${encodeURIComponent(zone)}&signal_type=co2_moer&horizon_hours=${Math.max(hours, 1)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${await bearer()}` }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`WattTime ${res.status}`);
      const body = (await res.json()) as { data: { point_time: string; value: number }[] };
      const hourly = body.data.filter((_, i) => i % 12 === 0).slice(0, hours + 1); // 12 × 5 min = 1 h
      return {
        zone,
        startHour: new Date(hourly[0].point_time).getUTCHours(),
        values: hourly.map(p => p.value * LBS_PER_MWH_TO_G_PER_KWH),
        source: 'WattTime',
        method: 'marginal (MOER)',
        live: true,
      };
    },
  };
}

/** Picks the real provider for a scenario when its credentials are set, the mock otherwise. */
export function providerFor(scenario: Scenario): CarbonProvider {
  if (scenario.source === 'Electricity Maps' && config.carbon.electricityMapsKey) return electricityMapsProvider();
  if (scenario.source === 'WattTime' && config.carbon.wattTimeUser) return wattTimeProvider();
  return mockProvider(scenario);
}
