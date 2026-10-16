import { t, language } from './i18n.js';
import styles from './panel.css';

function makeMovable(panel, handle) {
  const controller = new AbortController(), options = { signal: controller.signal };
  let drag = null, moved = false;
  function place(left, top) {
    const rect = panel.getBoundingClientRect(), margin = 12;
    Object.assign(panel.style, {
      left: Math.max(margin, Math.min(left, innerWidth - rect.width - margin)) + 'px',
      top: Math.max(margin, Math.min(top, innerHeight - rect.height - margin)) + 'px',
      right: 'auto', bottom: 'auto',
    });
  }
  function keepInView() { if (moved) { const rect = panel.getBoundingClientRect();place(rect.left, rect.top); } }
  function finish(event) {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.id)) return;
    const id = drag.id;drag = null;handle.classList.remove('dragging');
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    const rect = panel.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    handle.setPointerCapture(event.pointerId);handle.classList.add('dragging');event.preventDefault();
  }, options);
  handle.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;place(drag.left + dx, drag.top + dy);
  }, options);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finish, options);
  window.addEventListener('blur', finish, options);window.addEventListener('resize', keepInView, options);
  const observer = new ResizeObserver(keepInView);observer.observe(panel);
  return () => { finish();observer.disconnect();controller.abort(); };
}

export function createPanel() {
  const host = document.createElement('div');host.id = 'nurupuru-anywhere';
  for (const [key, value] of Object.entries({ all: 'initial', position: 'absolute', left: '0', top: '0', width: '0', height: '0', 'z-index': '2147483647', 'pointer-events': 'none' })) host.style.setProperty(key, value, 'important');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${styles}</style><canvas id="canvas"></canvas><div id="highlight"></div><div id="hit" hidden></div><div id="cursor" aria-hidden="true" hidden><div></div></div>
    <section lang="${language}" dir="ltr" id="panel" aria-label="Nurupuru Anywhere">
      <header><div id="panelHandle" title="${t('movePanel')}"><strong>${t('brand')} <small>Anywhere</small></strong><span id="status" role="status" aria-live="polite"></span></div><button id="fold" aria-expanded="true" aria-controls="detail">${t('fold')}</button><button id="close" title="${t('closeTitle')}">${t('close')}</button></header>
      <div class="image-controls"><button id="select" aria-keyshortcuts="I"><span id="selectLabel">${t('selectImage')}</span><small id="selectHint"></small><small class="key" aria-hidden="true">I</small></button><button id="enabled" aria-pressed="true" title="${t('pause')}">ON</button><button id="release" title="${t('releaseTitle')}" hidden>${t('release')}</button></div>
      <div id="detail">
      <fieldset id="editing" hidden>
      <div class="tool-labels"><span>${t('paintGuide')}</span><span id="grabGuide">${t('grabGuide')}</span><button id="reset" hidden>${t('reset')}</button></div>
      <div id="tools" role="group" aria-label="${t('tools')}"><button data-tool="brush" aria-pressed="true">${t('brush')} <small>B</small></button><button data-tool="erase" aria-pressed="false">${t('erase')} <small>E</small></button><button data-tool="grab" aria-pressed="false">${t('grab')} <small>G</small></button></div>
      <div id="brush">
        <label>${t('size')} <input id="size" type="range" min="8" max="240" value="68"><output id="sizeValue">68 px</output></label>
        <label id="strengthRow">${t('mobility')} <input id="strength" type="range" min="0" max="255" value="255"><output id="strengthValue">255</output></label>
        <div class="actions"><button id="fill">${t('fill')}</button><button id="clear">${t('clear')}</button></div>
      </div>
      <div id="grab">
        <label>${t('grabRadius')} <input id="grabRadius" type="range" min="20" max="300" value="110"><output id="grabRadiusValue">110 px</output></label>
        <label class="check"><input id="showGrabRange" type="checkbox" checked>${t('showGrabRange')}</label>
      </div>
      <details id="material"><summary>${t('material')}</summary>
        <div class="presets" role="group" aria-label="${t('materialPresets')}"><button data-material="rubber">${t('firm')}</button><button data-material="jelly" aria-pressed="true">${t('standard')}</button><button data-material="soft">${t('soft')}</button></div>
        <label>${t('softness')} <input id="softness" type="range" min="0" max="100"><output id="softnessValue"></output></label>
        <label>${t('returnSpeed')} <input id="returnSpeed" type="range" min="0" max="100" value="48"><output id="returnSpeedValue">48</output></label>
        <label>${t('damping')} <input id="damping" type="range" min="0" max="100" value="32"><output id="dampingValue">32</output></label>
      </details>
      </fieldset>
      </div></section>`;
  document.documentElement.append(host);
  const $ = id => root.getElementById(id), canvas = $('canvas'), hit = $('hit'), highlight = $('highlight');
  const dispose = makeMovable($('panel'), $('panelHandle'));
  return { host, root, $, canvas, hit, highlight, dispose };
}
