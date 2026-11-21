/* Spend policies page: the SolvaPay account, the agent, and both gates' settings.
 *
 * Budget limits are SolvaPay's. In demo mode they're editable here (they configure the local
 * stand-in); in sandbox mode they're read-only because they live in your SolvaPay account.
 * The carbon cap is SolvaGreen's and is always editable here.
 */

const {$, money, smallMoney, api} = SG;

// Send edits at most every 400 ms while the owner is typing.
let policyTimer = null;
function sendPolicy(patch){
  clearTimeout(policyTimer);
  policyTimer = setTimeout(() => api('/api/policy', 'PUT', patch), 400);
}
$('pCarb').oninput = () => sendPolicy({carbonCap: +$('pCarb').value});
$('pPer').oninput = () => sendPolicy({perCall: +$('pPer').value});
$('pDay').oninput = () => sendPolicy({perDay: +$('pDay').value});
$('pMon').oninput = () => sendPolicy({perMonth: +$('pMon').value});
$('pGreen').oninput = () => sendPolicy({greenPremiumLimit: +$('pGreen').value});

SG.page({
  render(S){
    const sc = S.scenario, b = S.policy.budget;

    $('company').textContent = sc.company;
    $('holder').textContent = `${sc.holder} · ${sc.holderRole}`;
    $('agentId').textContent = `${S.agent.agentRef} · ${S.agent.harness}`;

    // Only overwrite an input the owner isn't typing in right now.
    const setInput = (id, v, disabled) => { const el = $(id); if (document.activeElement !== el) el.value = v ?? ''; el.disabled = disabled; };
    setInput('pCarb', S.policy.carbonCap, false);
    setInput('pPer', b?.perCall, !b);
    setInput('pDay', b?.perDay, !b);
    setInput('pMon', b?.perMonth, !b);

    $('budgetNote').textContent = b
      ? 'Enforced by SolvaPay at authorize time (local stand-in in demo mode).'
      : 'Managed in your SolvaPay account. Edit limits in SolvaPay.';
    if (b) {
      $('dayTxt').textContent = money(b.spentToday); $('dayCap').textContent = money(b.perDay, 0);
      $('monTxt').textContent = money(b.spentThisMonth); $('monCap').textContent = money(b.perMonth, 0);
      $('dayBar').style.width = Math.min(100, b.spentToday / b.perDay * 100) + '%';
      $('monBar').style.width = Math.min(100, b.spentThisMonth / b.perMonth * 100) + '%';
    } else {
      for (const id of ['dayTxt', 'dayCap', 'monTxt', 'monCap']) $(id).textContent = '—';
    }

    // Green-premium gate (SolvaGreen): the bar turns red once today's premium passes the limit
    const g = S.policy.greenPremium;
    setInput('pGreen', g.limit, false);
    $('greenTxt').textContent = money(Math.max(0, g.spent));
    $('greenCap').textContent = money(g.limit, 0);
    $('greenBar').style.width = (g.limit ? Math.min(100, Math.max(0, g.spent) / g.limit * 100) : 100) + '%';
    $('greenBar').style.background = g.spent > g.limit ? 'var(--red)' : '';

    $('carbLbl').textContent = sc.capLabel;
    $('srcPill').textContent = `${sc.source} · ${sc.method}${S.forecast[0]?.live ? ' · live' : ' · mock'}`;
    $('feeTxt').textContent = `${smallMoney(sc.quoteFee)} / quote`;
    $('srcNote').textContent = sc.note;
  },
});
