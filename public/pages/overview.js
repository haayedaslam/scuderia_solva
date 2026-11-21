/* Overview page: the headline numbers, the carbon forecast chart and the latest statement rows. */

const {$, esc, money, smallMoney, hh} = SG;

SG.page({
  render(S){
    renderKpis(S);
    renderChart(S);
    renderRecent(S);
  },
});

/**
 * The four benefit tiles. Each shows one headline number and one line of context.
 * Totals come from the gateway (S.kpis); "moved" is counted from the booked slots (S.chosen).
 * Before any job has run, the tiles show "—" with a short explanation.
 */
function renderKpis(S){
  const k = S.kpis;
  const booked = Object.values(S.chosen);
  const decided = k.auto + k.asked + k.refused;

  // 1. CO₂e avoided: the core benefit
  const avoided = k.baseKg - k.greenKg;
  $('kAvoided').textContent = booked.length ? `${avoided.toFixed(1)} kg` : '—';
  $('kAvoidedD').textContent = booked.length
    ? `${((avoided / k.baseKg) * 100).toFixed(0)}% less than a budget-only agent`
    : 'vs an agent that only checks budget';

  // 2. Jobs moved: shows the decentralisation (other region, later hour, or both)
  const moved = booked.filter(c => c.pick.zone !== c.baseline.zone || c.pick.offset > 0);
  const byRegion = moved.filter(c => c.pick.zone !== c.baseline.zone).length;
  $('kMoved').textContent = booked.length ? `${moved.length} of ${booked.length}` : '—';
  $('kMovedD').textContent = booked.length
    ? `${byRegion} to another region · ${moved.length - byRegion} to a later hour`
    : 'by region or by hour';

  // 3. Cost of going green: extra GPU spend + carbon data + ECT offsets, against the owner's daily limit
  const premium = k.greenCost - k.baseCost;
  const limit = S.policy.greenPremium.limit;
  $('kPremium').textContent = booked.length ? `${premium >= 0 ? '+' : '−'}${money(Math.abs(premium))}` : '—';
  $('kPremium').classList.toggle('good', booked.length > 0 && premium <= 0);
  $('kPremium').classList.toggle('bad', premium > limit);
  $('kPremiumD').textContent = booked.length
    ? `of ${money(limit, 0)}/day limit · incl. ${smallMoney(k.ectCost)} ECTs`
    : `limit ${money(limit, 0)}/day · incl. ECT offsets`;

  // 4. Paid without asking: oversight only when it matters
  $('kAuto').textContent = decided ? `${k.auto} of ${decided}` : '—';
  $('kAutoD').textContent = decided
    ? `${k.asked} needed you · ${k.refused} blocked`
    : 'within budget and under your cap';
}

/** The five newest statement rows. */
function renderRecent(S){
  const rows = S.ledger.slice(-5).reverse();
  $('recent').innerHTML = rows.map(r => `<tr>
      <td class="mono small">${hh(r.hour)}</td>
      <td><div class="m">${esc(r.merchant)}</div></td>
      <td>${esc(r.item)}</td>
      <td class="num">${smallMoney(r.amount)}</td>
      <td class="num">${r.kg == null ? '—' : r.kg.toFixed(1)}</td>
      <td><span class="dec ${r.decision.cls}">${esc(r.decision.txt)}</span></td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">Nothing yet. Run the agent from the toolbar or the <a class="see-all" href="/jobs">Job queue</a>.</td></tr>';
}

/* ── Chart ─────────────────────────────────────────────────────────────────
 * One line per zone (hourly forecast from the same provider the planner uses),
 * a dashed cap line, a green "clean" band, and booked slots (filled) next to the slots a
 * budget-only agent would have booked (hollow).
 * Axis layout: the left margin holds the tick numbers (right-aligned against
 * the plot) and, further left, the rotated unit title, so the two never overlap.
 * ─────────────────────────────────────────────────────────────────────────── */

const CW = 760, CH = 290;
const PAD = {L:64, R:14, T:14, B:44};
const Y_MAX = 800, HOURS = 24;
const plotW = CW - PAD.L - PAD.R, plotH = CH - PAD.T - PAD.B;
const cx = off => PAD.L + off / HOURS * plotW;                       // hours from now → x
const cy = g => PAD.T + (1 - Math.min(g, Y_MAX) / Y_MAX) * plotH;    // g/kWh → y
const AXIS = '#6b6b66', GRID = '#ececea';

function renderChart(S){
  const sc = S.scenario, cap = S.policy.carbonCap;
  const live = S.forecast[0]?.live;
  $('chartTitle').textContent = `24-hour ${sc.source} forecast`;
  $('chartSub').textContent = `${sc.granularity} · ${sc.method} · ${live ? 'live data' : 'mock data · now = 08:00'}`;

  const color = Object.fromEntries(S.zones.map(z => [z.key, z.color]));
  const start = S.forecast[0]?.startHour ?? 8;
  let s = '';

  s += `<rect x="${PAD.L}" y="${cy(cap)}" width="${plotW}" height="${PAD.T + plotH - cy(cap)}" fill="#eef7ee"/>`;

  // Y axis: gridlines and tick numbers right-aligned 8 px left of the plot
  for (let g = 0; g <= Y_MAX; g += 200) {
    s += `<line x1="${PAD.L}" x2="${CW - PAD.R}" y1="${cy(g)}" y2="${cy(g)}" stroke="${GRID}"/>`;
    s += `<text x="${PAD.L - 8}" y="${cy(g)}" dy="0.32em" font-size="10.5" text-anchor="end" fill="${AXIS}">${g}</text>`;
  }
  // Y title: rotated, centred on the plot, in its own column at the far left
  s += `<text transform="translate(16 ${PAD.T + plotH / 2}) rotate(-90)" font-size="11" text-anchor="middle" fill="${AXIS}">gCO₂/kWh</text>`;

  // X axis: hour ticks, then a title below them
  for (let off = 0; off <= HOURS; off += 4) {
    s += `<line x1="${cx(off)}" x2="${cx(off)}" y1="${PAD.T + plotH}" y2="${PAD.T + plotH + 4}" stroke="${AXIS}"/>`;
    s += `<text x="${cx(off)}" y="${PAD.T + plotH + 17}" font-size="10.5" text-anchor="middle" fill="${AXIS}">${off === 0 ? 'now' : hh(start + off).slice(0, 5)}</text>`;
  }
  s += `<text x="${PAD.L + plotW / 2}" y="${CH - 6}" font-size="11" text-anchor="middle" fill="${AXIS}">Start time (next 24 h)</text>`;
  s += `<line x1="${PAD.L}" x2="${CW - PAD.R}" y1="${PAD.T + plotH}" y2="${PAD.T + plotH}" stroke="#cfcfcb"/>`;

  // Forecast lines
  for (const f of S.forecast) {
    const d = f.values.slice(0, HOURS + 1).map((v, i) => (i ? 'L' : 'M') + cx(i).toFixed(1) + ',' + cy(v).toFixed(1)).join('');
    s += `<path d="${d}" fill="none" stroke="${color[f.zone]}" stroke-width="2.2" stroke-linejoin="round"/>`;
  }

  // Cap line with label
  s += `<line x1="${PAD.L}" x2="${CW - PAD.R}" y1="${cy(cap)}" y2="${cy(cap)}" stroke="#141414" stroke-dasharray="5 4" stroke-width="1.2"/>`;
  s += `<rect x="${CW - PAD.R - 96}" y="${cy(cap) - 19}" width="96" height="16" rx="8" fill="#141414"/>`;
  s += `<text x="${CW - PAD.R - 48}" y="${cy(cap) - 8}" font-size="10" font-weight="600" text-anchor="middle" fill="#fff">cap ${cap} g/kWh</text>`;

  // Booked (filled) vs budget-only (hollow) slots
  for (const [id, {pick, baseline}] of Object.entries(S.chosen)) {
    s += `<circle cx="${cx(baseline.offset)}" cy="${cy(baseline.intensity)}" r="5.5" fill="#fff" stroke="${color[baseline.zone]}" stroke-width="2"/>`;
    s += `<circle cx="${cx(pick.offset)}" cy="${cy(pick.intensity)}" r="6.5" fill="${color[pick.zone]}" stroke="#fff" stroke-width="2"/>`;
    s += `<text x="${cx(pick.offset) + 9}" y="${cy(pick.intensity) - 9}" font-size="11" font-weight="700" fill="#141414">${id}</text>`;
  }

  s += `<g id="hover"></g><rect id="hit" x="${PAD.L}" y="${PAD.T}" width="${plotW}" height="${plotH}" fill="transparent"/>`;
  $('chart').innerHTML = s;
  $('legend').innerHTML = S.zones.map(z => `<span><i style="background:${z.color}"></i>${esc(z.name)} · ${money(z.price)}/GPU-h</span>`).join('');

  // Hover tooltip: snap to the nearest hour, list zones cleanest first
  $('hit').onmousemove = e => {
    const svg = $('chart'), pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    const off = Math.max(0, Math.min(HOURS, Math.round((loc.x - PAD.L) / plotW * HOURS)));
    const rows = S.forecast.map(f => ({zone: f.zone, v: f.values[off]})).filter(r => r.v != null).sort((a, b) => a.v - b.v);
    $('hover').innerHTML = `<line x1="${cx(off)}" x2="${cx(off)}" y1="${PAD.T}" y2="${PAD.T + plotH}" stroke="#141414" stroke-opacity=".25"/>` +
      rows.map(r => `<circle cx="${cx(off)}" cy="${cy(r.v)}" r="3.5" fill="${color[r.zone]}"/>`).join('');
    const tip = $('tip'), wrap = $('chartWrap').getBoundingClientRect();
    tip.innerHTML = `<div style="font-weight:600;margin-bottom:4px">${hh(start + off)}</div>` +
      rows.map(r => `<div class="r"><span><i style="background:${color[r.zone]}"></i>${r.zone}</span><span class="mono ${r.v <= cap ? 'good' : ''}">${r.v.toFixed(0)}</span></div>`).join('');
    tip.hidden = false;
    const x = e.clientX - wrap.left + 14;
    tip.style.left = (x + 180 > wrap.width ? x - 200 : x) + 'px';
    tip.style.top = (e.clientY - wrap.top - 20) + 'px';
  };
  $('hit').onmouseleave = () => { $('hover').innerHTML = ''; $('tip').hidden = true; };
}
