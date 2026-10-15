const source = svg => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
document.getElementById('sample').src = source(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="400" viewBox="0 0 480 400"><defs><linearGradient id="a" x2=".8" y2="1"><stop stop-color="#bce8f4"/><stop offset="1" stop-color="#8eafe5"/></linearGradient></defs><path d="M110 270c-29-63 12-157 77-175s162 19 177 96-12 130-104 133-125 0-150-54Z" fill="url(#a)"/><ellipse cx="195" cy="204" rx="7" ry="9" fill="#33475e"/><ellipse cx="282" cy="204" rx="7" ry="9" fill="#33475e"/><path d="M222 229q17 18 34 0" fill="none" stroke="#33475e" stroke-width="5" stroke-linecap="round"/><ellipse cx="171" cy="225" rx="14" ry="7" fill="#f2bdcd" opacity=".7"/><ellipse cx="304" cy="225" rx="14" ry="7" fill="#f2bdcd" opacity=".7"/><path d="M143 162q14-33 42-41" stroke="#fff" stroke-width="13" stroke-linecap="round" fill="none" opacity=".4"/></svg>`);
document.getElementById('other').src = source(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="400" viewBox="0 0 480 400"><g fill="#eeb08e"><ellipse cx="240" cy="150" rx="50" ry="86"/><ellipse cx="240" cy="250" rx="50" ry="86"/><ellipse cx="190" cy="200" rx="86" ry="50"/><ellipse cx="290" cy="200" rx="86" ry="50"/></g><circle cx="240" cy="200" r="59" fill="#f8d791"/><circle cx="222" cy="195" r="5" fill="#815b46"/><circle cx="258" cy="195" r="5" fill="#815b46"/><path d="M229 212q11 10 22 0" fill="none" stroke="#815b46" stroke-width="4" stroke-linecap="round"/></svg>`);

async function openUI() {
  if (document.getElementById('nurupuru-anywhere')) globalThis.__nurupuruAnywhere.wake();
  else await new Promise((resolve, reject) => {
    const script = document.createElement('script');script.src = '../dist/content.js';
    script.onload = resolve;script.onerror = () => reject(Error('先に npm run build を実行してください。'));
    document.body.append(script);
  });
  return document.getElementById('nurupuru-anywhere').shadowRoot;
}
async function showState(state) {
  const ui = await openUI(), $ = id => ui.getElementById(id);
  if ($('enabled').getAttribute('aria-pressed') === 'false') $('enabled').click();
  if (state === 'idle' || state === 'selecting') {
    if (!$('release').hidden) $('release').click();
    const selecting = $('panel').dataset.state === 'selecting';
    if ((state === 'selecting') !== selecting) $('select').click();
    return;
  }
  if ($('editing').hidden) {
    if ($('panel').dataset.state !== 'selecting') $('select').click();
    document.getElementById('sample').click();
    await new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      function ready() { if (!$('editing').hidden) resolve();else if (performance.now() > deadline) reject(Error($('status').textContent));else requestAnimationFrame(ready); }
      ready();
    });
    $('fill').click();
  }
  if ($('panel').dataset.state === 'selecting') $('select').click();
  ui.querySelector('[data-tool=' + (['brush', 'erase', 'grab'].includes(state) ? state : 'grab') + ']').click();
  if (state === 'off') $('enabled').click();
  if (state === 'folded') $('fold').click();
}
for (const button of document.querySelectorAll('[data-state]')) button.onclick = () => showState(button.dataset.state).catch(error => alert(error.message));
void openUI().catch(error => alert(error.message));
