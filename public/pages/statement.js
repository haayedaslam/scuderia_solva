/* Statement page: every payment, approval and refusal, newest first, with CSV export. */

const {$, esc, smallMoney, hh} = SG;

SG.page({
  render(S){
    const paid = S.ledger.reduce((sum, r) => sum + r.amount, 0);
    $('stmtSub').textContent = `${S.ledger.length} entries · ${smallMoney(paid)} paid`;
    $('ledger').innerHTML = S.ledger.slice().reverse().map(r => `<tr>
        <td class="mono small">${hh(r.hour)}</td>
        <td><div class="m">${esc(r.merchant)}</div><div class="s2">${esc(S.agent.name)} · ${esc(S.agent.agentRef)}</div></td>
        <td>${esc(r.item)}</td>
        <td class="num">${smallMoney(r.amount)}</td>
        <td class="num">${r.intensity == null ? '—' : r.intensity.toFixed(0)}</td>
        <td class="num">${r.kg == null ? '—' : r.kg.toFixed(1)}</td>
        <td><span class="dec ${r.decision.cls}">${esc(r.decision.txt)}</span></td>
        <td class="mono small">${r.callRef ? esc(r.callRef) : '—'}</td></tr>`).join('')
      || '<tr><td colspan="8" class="empty">No transactions yet. Every payment and every refusal shows up here.</td></tr>';
  },
});

/** Downloads the statement as CSV. */
$('csv').onclick = () => {
  const S = SG.state;
  if (!S) return;
  const cols = ['transaction_id', 'timestamp', 'job', 'merchant', 'item', 'amount_usd', 'intensity_g_per_kwh', 'kg_co2e', 'decision', 'solvapay_call_ref', 'booking_id'];
  const rows = [cols, ...S.ledger.map(r => [r.id, r.ts, r.jobId, r.merchant, r.item, r.amount, r.intensity ?? '', r.kg ?? '', r.decision.txt, r.callRef ?? '', r.bookingId ?? ''])];
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
  a.download = `solvagreen-statement-${S.scenario.key}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};
