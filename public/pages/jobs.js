/* Job queue page: the agent's requests, their outcomes, and each request's carbon footprint.
 *
 * Every card shows the footprint: what the job emits after SolvaGreen shifts it, next to what it
 * would emit as requested (cheapest region, right now). Requests whose footprint AS REQUESTED is
 * large (≥ LARGE_KG) also show the journey and the matching ECT offset: requested kg → kg left
 * after shifting → tokens to cover the rest, with their cost, one chip per token, and whether they
 * were bought. Before a job runs these are the planner's estimates (≈); after it runs they are the
 * real booking and the tokens actually retired.
 *
 * "Run agent" starts the built-in demo agent on one job; the toolbar's button runs every queued one.
 */

const {$, esc, api} = SG;

const LABEL = {running: 'Checking…', auto: 'Auto-paid', appr: 'Approved by you', dec: 'Declined', ref: 'Refused'};

/**
 * A request counts as a larger footprint when, as requested (budget-only: cheapest region, now),
 * it would emit at least this many kgCO₂e. Measured before shifting, because that's the size of
 * what was asked for; the offset shown covers what is left after shifting.
 */
const LARGE_KG = 10;
/** Show at most this many token chips on a card; the rest become "+N". */
const MAX_CHIPS = 48;

/** What happened (or will happen) to the offset, in a few words. */
function offsetStatus(j, autoBuy){
  const f = j.footprint;
  if (f.lot) return {cls: 'ok', txt: `Retired · ${f.lot.serialFrom.slice(-6)}–${f.lot.serialTo.slice(-6)}`};
  if (j.status === 'ref') return {cls: 'no', txt: 'Refused · nothing bought'};
  if (j.status === 'dec') return {cls: 'no', txt: 'Declined · nothing bought'};
  if (!autoBuy) return {cls: 'meter', txt: 'Auto-buy off'};
  return {cls: 'meter', txt: j.status === 'running' ? 'Buying after booking…' : 'Auto-buys after booking'};
}

function footprintBlock(j, S, color){
  const f = j.footprint;
  const est = f.estimated ? '≈ ' : '';
  const line = `<div class="fp"><span class="muted">Footprint</span> <b>${est}${f.kg.toFixed(1)} kgCO₂e</b>
    <span class="muted">· ${f.baselineKg.toFixed(1)} kg as requested</span></div>`;
  if (f.baselineKg < LARGE_KG) return line;

  const shown = Math.min(f.tokens, MAX_CHIPS);
  const chips = Array.from({length: shown}, () => `<i style="background:${color[f.zone] || 'var(--green)'}"></i>`).join('');
  const st = offsetStatus(j, S.ect.autoBuy);
  return line + `
    <div class="offset ${f.lot ? 'done' : ''}">
      <div class="offset-h">
        <span class="tag sg">Larger footprint</span>
        <span>Offset <b>${est}${f.tokens} ECT${f.tokens === 1 ? '' : 's'}</b> · $${f.ectCost.toFixed(f.ectCost < 1 ? 3 : 2)}</span>
      </div>
      <div class="journey">${j.status === 'ref' || j.status === 'dec'
        ? `${f.baselineKg.toFixed(1)} kg requested → <b>not run</b>, so nothing emitted or offset`
        : `${f.baselineKg.toFixed(1)} kg requested → ${est}${f.kg.toFixed(1)} kg after shifting → <b>${est}0 kg</b> after offset`}</div>
      <div class="chips">${chips}${f.tokens > shown ? `<span class="more">+${f.tokens - shown}</span>` : ''}</div>
      <div class="offset-f"><span class="dec ${st.cls}">${esc(st.txt)}</span><a class="see-all" href="/tokens">Wallet →</a></div>
    </div>`;
}

// "Generate requests": asks the gateway for N more varied race-weekend requests
$('gen').onclick = async () => {
  $('gen').disabled = true;
  try { await api('/api/jobs/generate', 'POST', {count: +$('genCount').value}); }
  finally { $('gen').disabled = false; }
};

// Process filter: which discipline to show (kept in the page only, not on the server)
let filter = 'All';

function renderFilter(S){
  const counts = {};
  for (const j of S.jobs) counts[j.process] = (counts[j.process] || 0) + 1;
  const procs = ['All', ...Object.keys(counts).sort()];
  if (!procs.includes(filter)) filter = 'All';
  $('procFilter').innerHTML = procs.map(p =>
    `<button class="chip-btn ${p === filter ? 'on' : ''}" data-p="${esc(p)}">${esc(p)} <span>${p === 'All' ? S.jobs.length : counts[p]}</span></button>`).join('');
  document.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { filter = b.dataset.p; render(SG.state); });
}

function render(S){
    const color = Object.fromEntries(S.zones.map(z => [z.key, z.color]));
    const large = S.jobs.filter(j => j.footprint.baselineKg >= LARGE_KG).length;
    const queued = S.jobs.filter(j => !j.status).length;
    $('jobsSub').textContent = `${S.jobs.length} requests from ${S.agent.name} · ${queued} queued · ${large} with a larger footprint`;
    renderFilter(S);
    const shown = filter === 'All' ? S.jobs : S.jobs.filter(j => j.process === filter);
    $('jobs').innerHTML = shown.map(j => `
      <div class="job ${j.status === 'running' ? 'run' : ''} ${j.id === 'J5' ? 'inj' : ''}">
        <div class="proc p-${j.process.toLowerCase().replace(/[^a-z]+/g, '-')}">${esc(j.process)}</div>
        <div class="t">${esc(j.name)} <span class="jid">${j.id}</span></div>
        <div class="n">${esc(j.note)}</div>
        ${footprintBlock(j, S, color)}
        <div class="meta"><span class="st ${j.status || ''}">${LABEL[j.status] || 'Queued'}</span>
          <button class="btn ghost sm" data-j="${j.id}" ${j.status || S.busy ? 'disabled' : ''}>Run agent</button></div>
      </div>`).join('');
    // The cards were just rebuilt, so their buttons need wiring again.
    document.querySelectorAll('[data-j]').forEach(btn => btn.onclick = () => api('/api/demo/run', 'POST', {jobId: btn.dataset.j}));
}

SG.page({ render });
