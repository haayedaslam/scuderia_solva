/* =============================================================================
 * SolvaGreen dashboard: shared shell, loaded by every page
 * -----------------------------------------------------------------------------
 * Every page (Overview, Spend policies, Job queue, Call log, Statement) loads this
 * file first. It does everything that is the same on all pages, so each page's own
 * script (public/pages/*.js) only draws its own content:
 *
 *   - the top navigation, the toolbar (race label, Run, Reset) and the footer
 *   - the connection to the gateway: GET /api/state + live updates on /api/events
 *   - the approval pop-up. Approvals can arrive while you're on ANY page, so
 *     every page must be able to show them.
 *
 * A page plugs in with:
 *     SG.page({ render(S) { ...draw from snapshot S... }, onLog(line) { ... } })
 *
 * No business logic lives in the browser. Decisions happen on the gateway (src/).
 * ========================================================================== */

(() => {
  /* ── helpers shared with page scripts ───────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const money = (x, d = 2) => '$' + Number(x).toLocaleString('en-US', {minimumFractionDigits:d, maximumFractionDigits:d});
  const smallMoney = x => (x > 0 && x < 0.01) ? '$' + x.toFixed(3) : money(x);
  const hh = h => String(Math.floor(h) % 24).padStart(2, '0') + ':00' + (h >= 24 ? ' +1d' : '');

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {method, headers:{'content-type':'application/json'}, body: body ? JSON.stringify(body) : undefined});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.warn(method, path, res.status, data);
    return data;
  }

  /* ── the SolvaPay mark (shown in green as SolvaGreen's logo) ─────────────── */
  const MARK_PATHS = '<path d="M13.26,44.31c-2.91-3.47-2.46-8.63,1.01-11.54,3.47-2.91,8.65-2.46,11.57,1.01l43.39,51.6c2.91,3.47,2.46,8.63-1.01,11.54-3.47,2.91-8.65,2.46-11.57-1.01L13.26,44.31Z"/><path d="M50.49,14.81c-2.91-3.47-2.46-8.63,1.01-11.54,3.47-2.91,8.65-2.46,11.57,1.01l43.4,51.6c2.91,3.47,2.46,8.63-1.01,11.54-3.47,2.91-8.65,2.46-11.57-1.01L50.49,14.81Z"/><path d="M85.52,17.67c-4.54,0-8.21-3.67-8.21-8.19s3.68-8.19,8.21-8.19h38.32c4.54,0,8.21,3.67,8.21,8.19s-3.68,8.19-8.21,8.19h-38.32Z"/><path d="M89.18,150.2c4.53,0,8.21,3.67,8.21,8.19s-3.68,8.19-8.21,8.19h-38.32c-4.53,0-8.21-3.67-8.21-8.19s3.68-8.19,8.21-8.19h38.32Z"/><path d="M108.15,42.07c-4.54,0-8.21-3.67-8.21-8.19s3.68-8.19,8.21-8.19h38.32c4.54,0,8.21,3.67,8.21,8.19s-3.68,8.19-8.21,8.19h-38.32Z"/><path d="M68.02,126.91c4.53,0,8.21,3.67,8.21,8.19s-3.68,8.19-8.21,8.19H29.7c-4.53,0-8.21-3.67-8.21-8.19s3.68-8.19,8.21-8.19h38.32Z"/><path d="M127.86,66.46c-4.54,0-8.21-3.67-8.21-8.19s3.68-8.19,8.21-8.19h38.32c4.53,0,8.21,3.67,8.21,8.19s-3.68,8.19-8.21,8.19h-38.32Z"/><path d="M50.13,102.51c4.53,0,8.21,3.67,8.21,8.19s-3.68,8.19-8.21,8.19H11.82c-4.53,0-8.21-3.67-8.21-8.19s3.68-8.19,8.21-8.19h38.32Z"/><path d="M70.56,112.4c-2.91-3.47-2.46-8.63,1.01-11.54s8.65-2.46,11.57,1.01l43.39,51.6c2.91,3.47,2.46,8.63-1.01,11.54-3.47,2.91-8.65,2.46-11.57-1.01l-43.39-51.6Z"/><path d="M109.12,84.18c-2.91-3.47-2.46-8.63,1.01-11.54,3.47-2.91,8.65-2.46,11.57,1.01l43.4,51.6c2.91,3.47,2.46,8.63-1.01,11.54-3.47,2.91-8.65,2.46-11.57-1.01l-43.4-51.6Z"/><path d="M32.23,30.2c-2.91-3.47-2.46-8.63,1.01-11.54,3.47-2.91,8.65-2.46,11.57,1.01l43.4,51.6c2.91,3.47,2.46,8.63-1.01,11.54-3.47,2.91-8.65,2.46-11.57-1.01L32.23,30.2Z"/><path d="M90.34,99.47c-2.91-3.47-2.46-8.63,1.01-11.54,3.47-2.91,8.65-2.46,11.57,1.01l43.4,51.6c2.91,3.47,2.46,8.63-1.01,11.54-3.47,2.91-8.65,2.46-11.57-1.01l-43.4-51.6Z"/>';
  const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="mark" viewBox="0 0 180.04 167.18">${MARK_PATHS}</symbol></defs></svg>`;

  /* ── navigation: one tab per page ────────────────────────────────────────── */
  const TABS = [
    {href:'/',          key:'overview',  label:'Overview'},
    {href:'/policies',  key:'policies',  label:'Spend policies'},
    {href:'/jobs',      key:'jobs',      label:'Job queue'},
    {href:'/emergency', key:'emergency', label:'Emergency'},
    {href:'/log',       key:'log',       label:'Call log'},
    {href:'/statement', key:'statement', label:'Statement'},
    {href:'/tokens',    key:'tokens',    label:'Carbon tokens'},
  ];
  const current = document.body.dataset.page;

  function mountShell(){
    document.body.insertAdjacentHTML('afterbegin', SPRITE + `
      <nav class="top"><div class="wrap">
        <a class="logo" href="/"><svg><use href="#mark"/></svg><span>Solva<b>Green</b></span></a>
        <div class="tabs">${TABS.map(t => `<a href="${t.href}" class="${t.key === current ? 'on' : ''}" ${t.key === current ? 'aria-current="page"' : ''}>${t.label}${t.key === 'jobs' ? '<span class="badge" id="apprBadge" hidden></span>' : ''}</a>`).join('')}</div>
        <div class="nav-r">
          <span class="pill" title="Where payments go"><span class="dot"></span><span id="modeTxt">Connecting…</span></span>
          <span class="pill live"><span class="dot"></span><span id="clock">Fri 08:00 · 20 Nov 2026</span></span>
          <span class="powered">Spending runs on <svg><use href="#mark"/></svg><b>SolvaPay</b></span>
          <span class="avatar" id="avatar"></span>
        </div>
      </div></nav>`);

    // Toolbar: every page has a <div id="toolbar"> in its header
    const tb = $('toolbar');
    if (tb) tb.innerHTML = `
      <div class="race-pill">Las Vegas GP 2026 · WattTime</div>
      <div class="actions">
        <button class="btn ghost" id="reset">Reset</button>
        <button class="btn" id="runAll">Run agent on all jobs →</button>
      </div>`;

    document.body.insertAdjacentHTML('beforeend', `
      <footer><div class="wrap">
        <span>SolvaGreen is a hackathon prototype. Budget checks, approvals and settlement run through the SolvaPay agent-payments SDK (preview); the carbon gate is SolvaGreen's own layer, not a SolvaPay product. <span id="footMode"></span></span>
        <span>Demo scenario for illustration only: McLaren Racing, Will Joseph and Lando Norris are named as an example customer. SolvaGreen is not affiliated with or endorsed by McLaren or anyone named.</span>
      </div></footer>
      <div id="offline" hidden>Lost connection to the SolvaGreen gateway. Is <code>npm start</code> running?</div>
      <div id="modalBg" hidden><div id="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle">
        <div class="who"><span class="agent-ic">PA</span><span id="mWho"></span></div>
        <h3 id="mTitle">Approval needed</h3>
        <div class="amt" id="mAmt"></div>
        <div class="why" id="mWhy"></div>
        <dl id="mDl"></dl>
        <div class="btns"><button class="btn ghost" id="mNo">Decline</button><button class="btn ghost" id="mRaise">Raise limit</button><button class="btn" id="mYes">Allow this call</button></div>
        <div class="note">Only you can approve this. Your agent can't.</div>
      </div></div>`);

    // Toolbar actions
    if ($('runAll')) {
      $('runAll').onclick = () => api('/api/demo/run', 'POST', {});
      $('reset').onclick = () => { page.onReset?.(); api('/api/demo/reset', 'POST'); };
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('modalBg').hidden) $('mNo').click(); });
  }

  /* ── shared parts of every render ─────────────────────────────────────────── */
  function renderShell(S){
    const demo = S.mode === 'demo';
    // Short label keeps the nav on one line; the full explanation is in the tooltip.
    $('modeTxt').textContent = demo ? 'Demo mode' : 'SolvaPay sandbox';
    $('modeTxt').parentElement.title = demo ? 'Demo mode: a local stand-in plays SolvaPay; no real money moves' : 'Payments go to the SolvaPay sandbox with test money';
    $('avatar').textContent = S.scenario.holder.split(/[\s.]+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    $('avatar').title = `${S.scenario.holder} · ${S.scenario.holderRole} · ${S.scenario.company}`;
    $('footMode').textContent = demo
      ? 'Demo mode: a local stand-in plays SolvaPay; carbon data is mocked unless API keys are set.'
      : 'Sandbox mode: payments go to the SolvaPay sandbox with test money.';
    if ($('runAll')) {
      $('runAll').disabled = S.busy || S.jobs.every(j => j.status);
      $('reset').disabled = S.busy;
    }
    const n = S.approvals.length;
    $('apprBadge').hidden = !n;
    $('apprBadge').textContent = n;
    syncApproval(S);
  }

  /* ── approval pop-up ───────────────────────────────────────────────────────
   * Opens when the gateway reports a pending approval. Three kinds:
   *   carbon  : SolvaGreen's (over the carbon cap). No "Raise limit": the cap is policy.
   *   premium : SolvaGreen's (going green would pass the daily cost-of-green limit). Can be raised.
   *   budget  : SolvaPay's spend limit (demo stand-in only; in sandbox mode you answer in SolvaPay).
   * The agent's request is held open on the server until you click.
   * ─────────────────────────────────────────────────────────────────────────── */
  let shownApproval = null;
  function syncApproval(S){
    const a = S.approvals[0];
    if (!a) { $('modalBg').hidden = true; shownApproval = null; return; }
    if (shownApproval === a.id) return;
    shownApproval = a.id;
    $('mTitle').textContent = a.title;
    const gateName = {carbon: 'SolvaGreen carbon gate', premium: 'SolvaGreen green-premium limit', budget: 'SolvaPay spend limit'}[a.kind];
    $('mWho').innerHTML = `<b style="color:var(--ink)">${esc(S.agent.name)}</b> is asking · ${gateName}`;
    $('mAmt').textContent = money(a.amount);
    $('mWhy').innerHTML = a.reasons.map(r => `<div>${esc(r)}</div>`).join('');
    $('mDl').innerHTML = Object.entries(a.details).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('mRaise').hidden = !a.canRaise;
    $('modalBg').hidden = false;
    $('mYes').focus();
    const decide = decision => { $('modalBg').hidden = true; api(`/api/approvals/${a.id}`, 'POST', {decision}); };
    $('mYes').onclick = () => decide('approve');
    $('mNo').onclick = () => decide('decline');
    $('mRaise').onclick = () => decide('raise');
  }

  /* ── connection to the gateway ───────────────────────────────────────────── */
  let page = {};
  let refreshTimer = null;

  // One booking emits several events at once, so batch them into a single re-fetch.
  function scheduleRefresh(){ clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 60); }

  async function refresh(){
    try {
      SG.state = await api('/api/state');
      $('offline').hidden = true;
      renderShell(SG.state);
      page.render?.(SG.state);
    } catch { $('offline').hidden = false; }
  }

  function listen(){
    const es = new EventSource('/api/events'); // the browser reconnects by itself if the server restarts
    es.onmessage = e => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'log') page.onLog?.(ev.line);
      else scheduleRefresh();
    };
    es.onerror = () => { $('offline').hidden = false; };
    es.onopen = () => { $('offline').hidden = true; refresh(); };
  }

  /* ── public API for page scripts ─────────────────────────────────────────── */
  window.SG = {
    state: null,
    $, esc, money, smallMoney, hh, api,
    /** Called once by each page script with its render/onLog/onReset hooks. */
    page(hooks){
      page = hooks;
      mountShell();
      listen();
      refresh();
    },
  };
})();
