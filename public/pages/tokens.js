/* Carbon tokens page: the ECT wallet (holdings, coverage, one chip per token) and every lot bought.
 *
 * ECTs are bought by the gateway (src/http/agentApi.ts → buyEcts) right after a job is booked.
 * This page only displays them, plus the owner's auto-buy switch.
 */

const {$, esc, money, smallMoney, api} = SG;

$('autoBuy').onchange = () => api('/api/policy', 'PUT', {ectAutoBuy: $('autoBuy').checked});

// Show at most this many chips per lot; the rest are summarised as "+N".
const MAX_CHIPS = 120;

SG.page({
  render(S){
    const e = S.ect;
    const color = Object.fromEntries(S.zones.map(z => [z.key, z.color]));
    const covered = e.tokens; // 1 ECT = 1 kg
    const coverage = e.emittedKg > 0 ? Math.min(1, covered / e.emittedKg) : null;

    // Auto-buy switch
    $('autoBuy').checked = e.autoBuy;
    $('autoBuyTxt').textContent = e.autoBuy ? 'Auto-buy on' : 'Auto-buy off';

    // Stats
    $('eTokens').textContent = e.tokens;
    $('eTokensD').textContent = `across ${e.lots.length} lot${e.lots.length === 1 ? '' : 's'}`;
    $('eCover').textContent = coverage == null ? '—' : `${Math.floor(coverage * 100)}%`;
    $('eCoverD').textContent = coverage == null ? 'of what booked jobs still emit' : (coverage >= 1 ? 'booked jobs are carbon-neutral' : 'some jobs are not offset');
    $('eSpent').textContent = money(e.spent);
    $('ePrice').textContent = '$' + e.pricePerToken.toFixed(3); // fractions of a cent matter at this scale
    $('ePriceD').textContent = `≈ ${money(e.pricePerToken * 1000, 0)} per tonne · mock price`;
    $('eCovKg').textContent = `${covered.toFixed(1)} kg`;
    $('eEmitKg').textContent = `${e.emittedKg.toFixed(1)} kg`;
    $('eBar').style.width = ((coverage ?? 0) * 100) + '%';

    // Wallet: one chip per token, grouped by lot, coloured by the grid the job ran on
    $('wallet').innerHTML = e.lots.length
      ? e.lots.map(l => {
          const shown = Math.min(l.tokens, MAX_CHIPS);
          const chips = Array.from({length: shown}, () => `<i style="background:${color[l.zone] || 'var(--green)'}"></i>`).join('');
          return `<div class="lot" title="${esc(l.serialFrom)} … ${esc(l.serialTo)}">
              <div class="lot-h"><b>${esc(l.jobId)}</b> · ${esc(l.zone)} · ${l.tokens} ECT${l.tokens === 1 ? '' : 's'}</div>
              <div class="chips">${chips}${l.tokens > shown ? `<span class="more">+${l.tokens - shown}</span>` : ''}</div>
            </div>`;
        }).join('')
      : `<div class="empty">No ECTs yet. ${e.autoBuy ? 'Each booked job is offset automatically.' : 'Auto-buy is off, so booked jobs are not offset.'}</div>`;

    // Lots table, newest first
    $('lots').innerHTML = e.lots.slice().reverse().map(l => `<tr>
        <td class="mono small">${esc(l.lotId)}</td>
        <td><div class="m">${esc(l.jobId)} · ${esc(l.jobName)}</div></td>
        <td><span class="zone-dot" style="background:${color[l.zone] || 'var(--green)'}"></span>${esc(l.zone)}</td>
        <td class="num">${l.tokens}</td>
        <td class="num">${l.kgOffset.toFixed(1)}</td>
        <td class="num">${smallMoney(l.cost)}</td>
        <td class="mono small">${esc(l.serialFrom)}<br>${esc(l.serialTo)}</td>
        <td class="mono small">${esc(l.callRef)}</td>
        <td><span class="dec ok">Retired</span></td></tr>`).join('')
      || '<tr><td colspan="9" class="empty">No lots yet.</td></tr>';
  },
});
