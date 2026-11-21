/* Call log page: every step as it happens.
 *
 * On load (and after a reset or scenario switch) it draws the history from the snapshot.
 * After that, new lines stream in through onLog() without re-fetching anything.
 */

const {$, esc} = SG;

let drawn = false; // has the history been drawn from a snapshot yet?

function append(line){
  $('log').querySelector('.empty')?.remove();
  const d = document.createElement('div');
  d.className = 'ev ' + (line.cls || '');
  d.innerHTML = `<span class="tm">${line.at}</span><span class="tx"><span class="who-tag ${line.source}">${line.source}</span>${esc(line.text)}</span><span class="amt">${line.amount || ''}</span>`;
  $('log').appendChild(d);
  $('log').scrollTop = 1e9; // keep the newest line in view
}

SG.page({
  render(S){
    // Redraw from history the first time, or when the server's log got shorter (it was reset).
    if (drawn && S.log.length >= $('log').querySelectorAll('.ev').length) return;
    drawn = true;
    $('log').innerHTML = S.log.length ? '' : '<div class="empty">Waiting for the agent. Run one job or all of them from the toolbar.</div>';
    S.log.forEach(append);
  },
  onLog(line){
    if (drawn) append(line);
  },
  onReset(){
    drawn = false;
  },
});
