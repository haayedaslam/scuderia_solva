/* Emergency freight page: an urgent air shipment offset at the moment of decision.
 *
 * The work happens on the gateway (POST /v1/offsets/emergency, called by the demo agent).
 * This page triggers it and shows each step as the server reports progress in S.emergency:
 *   1 emissions calculated → 2 Carbonmark projects scored → 3 SolvaPay budget + quality gate → 4 certificate
 */

const {$, esc, money, api} = SG;

$('trigger').onclick = () => api('/api/demo/emergency', 'POST');

const ORDER = ['idle', 'calculating', 'checking', 'paying', 'done'];
const VERDICT = {chosen: ['ok', 'Chosen · cheapest that passes'], pass: ['meter', 'Passes · pricier'], 'below bar': ['no', 'Below quality bar'], 'not enough supply': ['no', 'Not enough supply']};

/** Marks a step card as waiting / working / done. */
function stepState(id, n, e){
  const reached = ORDER.indexOf(e.status);
  const el = $(id);
  const stopped = e.status === 'stopped';
  el.classList.toggle('done', e.status === 'done' || reached > n || (stopped && n <= stopIndex(e)));
  el.classList.toggle('active', !stopped && e.status !== 'done' && reached === n); // never "working" once finished
  el.classList.toggle('fail', stopped && n === stopIndex(e) + 1);
}
const stopIndex = e => (e.gates?.budget ? 2 : e.gates?.quality ? 1 : 0);

SG.page({
  render(S){
    const e = S.emergency, s = e.shipment;

    // Shipment card
    $('shipId').textContent = s.id;
    $('shipItem').textContent = s.item;
    $('shipReason').textContent = s.reason;
    $('fromCode').textContent = s.from.code; $('fromName').textContent = s.from.name;
    $('toCode').textContent = s.to.code; $('toName').textContent = s.to.name;
    $('aircraft').textContent = s.aircraft.label;
    $('deadline').textContent = `${s.deadlineHours} h`;
    const running = !['idle', 'stopped'].includes(e.status) && e.status !== 'done';
    $('trigger').disabled = S.busy || e.status === 'done' || running;
    $('trigger').textContent = e.status === 'done' ? 'Offset complete ✓' : running ? 'Working…' : 'Trigger emergency offset →';
    $('triggerNote').textContent = e.status === 'done' ? 'Press Reset in the toolbar to run it again' : 'Runs the agent: calculate → Carbonmark check → SolvaPay → certificate';

    // Step 1: emissions
    if (e.calc) {
      $('s1v').innerHTML = `${e.calc.tCO2.toFixed(1)} <span>tCO₂</span>`;
      $('s1d').textContent = `${Math.round(e.calc.routedKm).toLocaleString('en-US')} km · ${e.calc.flightHours.toFixed(1)} h · ${Math.round(e.calc.fuelKg / 100) / 10} t fuel → ${e.calc.credits} credits`;
      $('assumptions').innerHTML = e.calc.assumptions.map(a => `<li>${esc(a)}</li>`).join('');
    } else { $('s1v').textContent = e.status === 'calculating' ? '…' : '—'; }

    // Step 2: Carbonmark + quality
    $('feedSrc').textContent = `${e.feedSource ?? 'Carbonmark'} · quality bar ${S.policy.qualityBar}/100`;
    if (e.candidates) {
      const pass = e.candidates.filter(p => p.verdict === 'pass' || p.verdict === 'chosen').length;
      $('s2v').innerHTML = e.chosen ? `${pass} <span>of ${e.candidates.length} pass</span>` : `0 <span>of ${e.candidates.length} pass</span>`;
      $('s2d').textContent = e.chosen ? `Chosen: ${e.chosen.key} · ${e.chosen.score.total}/100 · Tier ${e.chosen.tier} · $${e.chosen.pricePerTonne.toFixed(2)}/t` : 'Nothing meets the bar: nothing bought';
      $('cands').innerHTML = e.candidates.map(p => {
        const [cls, txt] = VERDICT[p.verdict];
        return `<tr class="${p.verdict === 'chosen' ? 'chosen' : ''}">
          <td><div class="m">${esc(p.name.length > 46 ? p.name.slice(0, 44) + '…' : p.name)}</div><div class="s2">${esc(p.key)} · ${esc(p.country)}</div></td>
          <td>${esc(p.registry)}</td><td>${esc(p.type)}</td>
          <td class="num">${p.vintage ?? '—'}</td><td class="num">${p.pricePerTonne.toFixed(2)}</td>
          <td><div class="score"><i style="width:${p.score.total}%" class="${p.score.total >= S.policy.qualityBar ? 'ok' : ''}"></i></div><span class="mono small">${p.score.total} · ${p.tier}</span></td>
          <td><span class="dec ${cls}">${txt}</span></td></tr>`;
      }).join('');
    } else {
      $('s2v').textContent = e.status === 'checking' ? '…' : '—';
    }

    // Step 3: the SolvaPay dual gate
    const g = e.gates || {};
    const chip = (name, x) => `<span class="gate-chip ${x ? (x.pass ? 'ok' : 'no') : ''}">${name} ${x ? (x.pass ? '✓' : '✗') : '—'}</span>`;
    $('s3v').innerHTML = chip('Budget', g.budget) + chip('Quality', g.quality);
    $('s3d').textContent = g.budget?.pass && g.quality?.pass
      ? (g.autoExecuted ? `Auto-executed · ${money(e.cost)} · no approval queue` : `${money(e.cost)} · ${g.budget.detail}`)
      : g.budget ? g.budget.detail : g.quality && !g.quality.pass ? g.quality.detail : 'both must pass to auto-execute';

    // Step 4: certificate
    const c = e.certificate;
    $('s4v').innerHTML = c ? `${c.tonnesRetired} <span>t retired</span>` : (e.status === 'paying' ? '…' : '—');
    $('s4d').textContent = c ? c.id : 'audit trail, from the payment itself';
    $('certStatus').textContent = c ? 'issued · simulated retirement' : e.status === 'stopped' ? 'not issued' : 'not issued yet';
    $('cert').className = c ? 'cert' : 'cert empty-cert';
    $('cert').innerHTML = c ? `
      <div class="cert-top"><svg><use href="#mark"/></svg><div><div class="cert-t">Carbon retirement certificate</div><div class="mono small">${esc(c.id)}</div></div><div class="seal">${c.tonnesRetired} t</div></div>
      <dl>
        <dt>Issued</dt><dd>${esc(c.issued)}</dd>
        <dt>Beneficiary</dt><dd>${esc(c.beneficiary)}</dd>
        <dt>Authorised by</dt><dd>${esc(c.authorisedBy)}</dd>
        <dt>Shipment</dt><dd>${esc(c.shipment)}</dd>
        <dt>Emissions</dt><dd>${esc(c.emissions)}</dd>
        <dt>Project</dt><dd>${esc(c.project)}</dd>
        <dt>Registry · vintage</dt><dd>${esc(c.registry)} · ${esc(c.vintage)} · ${esc(c.country)}</dd>
        <dt>Price · total</dt><dd>$${Number(c.pricePerTonne).toFixed(2)}/t · <b>${money(Number(c.cost))}</b></dd>
        <dt>SolvaPay ref</dt><dd class="mono">${esc(c.solvapayCallRef)}</dd>
        <dt>Settlement</dt><dd>${esc(c.settled)}</dd>
      </dl>
      <div class="cert-note">${esc(c.status)}</div>` : (e.error ? esc(e.error) : 'The retirement record appears here the moment the payment settles.');

    stepState('st1', 1, e); stepState('st2', 2, e); stepState('st3', 3, e); stepState('st4', 4, e);
  },
});
