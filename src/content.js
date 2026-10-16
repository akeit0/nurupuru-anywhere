import { t } from './i18n.js';
import { SoftMesh } from './core/physics.js';
import { GLRenderer } from './core/renderer.js';
import { DEFAULT_PARAMS, MATERIAL_PRESETS } from './core/settings.js';
import { readSource, readRegion, imageRect } from './source-image.js';
import { createPanel } from './panel.js';

const PARAM_FIELDS = { size: 'brushSize', strength: 'brushStrength', grabRadius: 'grabRadius', softness: 'softness', returnSpeed: 'returnSpeed', damping: 'damping' };
const TOOL_KEYS = { b: 'brush', e: 'erase', g: 'grab' };
const isSource = node => node instanceof HTMLImageElement || node instanceof HTMLCanvasElement || node instanceof HTMLIFrameElement;
const sourceLabel = target => target ? target.alt || target.getAttribute('aria-label') || target.title || (target instanceof HTMLCanvasElement ? t('canvas') : target instanceof HTMLIFrameElement ? t('embedded') : '') : t('region');

if (globalThis.__nurupuruAnywhere) globalThis.__nurupuruAnywhere.wake();
else start();

function start() {
  const params = { ...DEFAULT_PARAMS, maskOpacity: 50, grabRadius: 110 };
  let tool = 'brush', effect = null, selecting = true, loading = false, generation = 0, stopped = false, enabled = true;
  let raf = 0, lastTime = 0, accumulator = 0, gesture = null, cursorPoint = null, selection = null;
  const { host, root, $, canvas, hit, highlight, dispose: disposePanel } = createPanel();
  let renderer;
  let message = '';
  function notice(text) { message = text;$('status').textContent = enabled ? message : t('offStatus');$('status').title = $('status').textContent; }
  function requestFrame() { if (!raf && !stopped && enabled && !document.hidden) raf = requestAnimationFrame(frame); }
  function originalRect(e) {
    const r = e.source.region;
    return r ? { left: r.left - scrollX, top: r.top - scrollY, width: r.width, height: r.height } : imageRect(e.target);
  }
  function rectFor(e = effect) {
    const r = originalRect(e), s = e.source.slice;
    return { left: r.left + r.width * s.x, top: r.top + r.height * s.y, width: r.width * s.w, height: r.height * s.h };
  }
  function locate(node, rect) {
    Object.assign(node.style, { left: rect.left + scrollX + 'px', top: rect.top + scrollY + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  }
  function updateCursor(rect = effect ? rectFor() : null) {
    const cursor = $('cursor'), activeTool = gesture?.tool || tool;
    const inside = rect && cursorPoint && cursorPoint.x >= rect.left && cursorPoint.x <= rect.left + rect.width && cursorPoint.y >= rect.top && cursorPoint.y <= rect.top + rect.height;
    cursor.hidden = !enabled || selecting || loading || !effect || !cursorPoint || document.hidden || (!gesture && !inside) || (activeTool === 'grab' && !$('showGrabRange').checked);
    if (cursor.hidden) return;
    const diameter = activeTool === 'grab' ? params.grabRadius * 2 : params.brushSize;
    cursor.dataset.mode = activeTool;
    Object.assign(cursor.firstElementChild.style, { left: cursorPoint.x + 'px', top: cursorPoint.y + 'px', width: diameter + 'px', height: diameter + 'px' });
  }
  function trackCursor(event) {
    cursorPoint = event.pointerType === 'touch' ? null : { x: event.clientX, y: event.clientY };updateCursor();
  }
  function setOriginalHidden(hidden) {
    if (!effect?.target || hidden === effect.concealed) return;
    const e = effect, style = e.target.style;
    if (hidden) {
      e.opacity = style.getPropertyValue('opacity');e.priority = style.getPropertyPriority('opacity');
      style.setProperty('opacity', '0', 'important');
    } else if (style.getPropertyValue('opacity') === '0' && style.getPropertyPriority('opacity') === 'important') {
      if (e.opacity) style.setProperty('opacity', e.opacity, e.priority);else style.removeProperty('opacity');
    }
    e.concealed = hidden;
  }
  function releaseImage() {
    finishGesture();
    setOriginalHidden(false);effect?.target?.removeEventListener('load', sourceChanged);imageObserver.disconnect();
    effect = null;hit.hidden = true;lastTime = accumulator = 0;
    renderer?.dispose();renderer = null;canvas.width = canvas.width;
    updateControls();
  }
  function sourceChanged() { releaseImage();notice(t('sourceChanged')); }
  const imageObserver = new ResizeObserver(requestFrame);
  const pageObserver = new MutationObserver(() => {
    if (effect?.target && !effect.target.isConnected) sourceChanged();
    else if (effect) requestFrame();
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });

  function chooseImage() {
    finishSelection();finishGesture();generation++;selecting = true;highlight.hidden = true;
    notice(t('pickHint'));updateControls();
  }
  function cancelSelection() {
    finishSelection();selecting = false;highlight.hidden = true;updateControls();requestFrame();
    notice(effect ? toolHelp() : t('startHint'));
  }
  function toggleSelection() { selecting ? cancelSelection() : chooseImage(); }
  function detachImage() {
    finishSelection();generation++;loading = false;selecting = false;highlight.hidden = true;releaseImage();
    notice(t('released'));
  }
  function toolHelp() { return tool === 'grab' ? t('grabHelp') : tool === 'erase' ? t('eraseHelp') : t('brushHelp'); }
  function updateControls() {
    const state = !enabled ? 'off' : loading ? 'loading' : selecting ? 'selecting' : effect ? tool : 'idle';
    $('panel').dataset.state = state;
    $('enabled').textContent = enabled ? 'ON' : 'OFF';$('enabled').setAttribute('aria-pressed', String(enabled));$('enabled').title = enabled ? t('pause') : t('resume');
    $('selectLabel').textContent = loading ? t('loading') : selecting ? t('selecting') : effect ? t('changeImage') : t('selectImage');
    const name = effect ? sourceLabel(effect.target) : '';
    $('selectHint').textContent = selecting ? t('cancel') : name;
    $('select').setAttribute('aria-pressed', String(selecting));
    $('select').title = selecting ? t('selectingTitle') : effect ? t('changeTitle') + (name || t('selectedImage')) : t('selectTitle');
    $('select').disabled = loading || !enabled;
    $('release').hidden = !effect && !loading;
    $('editing').hidden = !effect;
    $('editing').disabled = !enabled || selecting || loading;
    $('picker').hidden = !enabled || !selecting || loading;
    $('brush').hidden = tool === 'grab';
    $('grab').hidden = tool !== 'grab';
    $('brush').inert = tool === 'grab';$('grab').inert = tool !== 'grab';
    $('reset').hidden = tool !== 'grab';$('grabGuide').hidden = tool === 'grab';
    $('strengthRow').hidden = tool !== 'brush';
    for (const button of root.querySelectorAll('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
    const active = enabled && !selecting && !loading && !!effect;
    setOriginalHidden(active);
    hit.hidden = !active;canvas.style.visibility = active ? '' : 'hidden';
    notice(message);
    hit.style.cursor = tool === 'grab' ? 'grab' : 'crosshair';
    updateCursor();
  }
  function setTool(next) {
    finishGesture();tool = next;updateControls();requestFrame();
    if (effect) notice(toolHelp());
  }
  async function selectImage(target, region) {
    if (loading) return;
    const job = ++generation;loading = true;selecting = false;highlight.hidden = true;updateControls();
    try {
      const source = region ? await readRegion(region, host) : await readSource(target, host);
      if (job !== generation || stopped) return;
      if (target && !target.isConnected) throw Error(t('imageRemoved'));
      releaseImage();
      const image = source.image, mask = document.createElement('canvas');
      mask.dataset.maskChannel = 'red';
      const scale = Math.min(1, 640 / Math.max(image.width, image.height));
      mask.width = Math.max(2, Math.round(image.width * scale));mask.height = Math.max(2, Math.round(image.height * scale));
      const ctx = mask.getContext('2d', { willReadFrequently: true });ctx.fillStyle = 'black';ctx.fillRect(0, 0, mask.width, mask.height);
      const mesh = new SoftMesh(image.width, image.height, 'eco');mesh.sampleMask(ctx, mask.width, mask.height);
      renderer = new GLRenderer(canvas);renderer.updateImage(image, mask, mesh);
      effect = { target, source, mask, ctx, mesh, dirty: false, revision: 0, concealed: false };
      if (target) { target.addEventListener('load', sourceChanged);imageObserver.observe(target); }
      setTool('brush');
      notice(region ? t('regionCaptured') : source.capture ? t('captured') : t('loaded'));
      requestFrame();
    } catch (error) {
      if (job !== generation || stopped) return;
      if (!effect) releaseImage();
      notice(error.message || t('loadFailed'));selecting = true;
    } finally { if (job === generation) { loading = false;updateControls(); } }
  }
  function point(event) {
    const rect = rectFor(), m = effect.mesh;
    return { x: (event.clientX - rect.left) * m.w / rect.width, y: (event.clientY - rect.top) * m.h / rect.height, zoom: rect.width / m.w };
  }
  function paint(from, to) {
    const e = effect, c = e.ctx, sx = e.mask.width / e.mesh.w, sy = e.mask.height / e.mesh.h;
    c.save();c.scale(sx, sy);c.strokeStyle = gesture.tool === 'erase' ? 'black' : 'rgb(' + params.brushStrength + ',255,0)';
    c.lineWidth = params.brushSize / to.zoom;c.lineCap = c.lineJoin = 'round';
    c.beginPath();c.moveTo(from.x, from.y);c.lineTo(to.x + .001, to.y);c.stroke();c.restore();
    e.dirty = true;requestFrame();
  }
  function flushMask() {
    if (!effect?.dirty) return;
    const e = effect;e.mesh.sampleMask(e.ctx, e.mask.width, e.mask.height);renderer.ensureMask(e.mask, ++e.revision);e.dirty = false;
  }
  function finishGesture() {
    if (!gesture) return;
    const ended = gesture;gesture = null;
    if (ended.tool === 'grab') effect?.mesh.endGrab();
    if (hit.hasPointerCapture(ended.id)) hit.releasePointerCapture(ended.id);
    flushMask();updateCursor();requestFrame();
  }
  hit.addEventListener('pointerenter', trackCursor);
  hit.addEventListener('pointerleave', () => { if (!gesture) { cursorPoint = null;updateCursor(); } });
  hit.addEventListener('pointerdown', event => {
    if (!enabled || selecting || loading || !effect || gesture || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault();event.stopPropagation();trackCursor(event);
    const p = point(event), active = event.button === 2 && tool === 'brush' ? 'erase' : tool;
    flushMask();
    if (active === 'grab') {
      // The slider uses screen pixels; the solver measures radius in image units.
      const grabParams = { ...params, grabRadius: params.grabRadius / p.zoom / effect.mesh.scale * 720 };
      if (!effect.mesh.beginGrab(p.x, p.y, 'grab', grabParams)) { notice(t('paintFirst'));return; }
    }
    gesture = { id: event.pointerId, tool: active, start: p, last: p };hit.setPointerCapture(event.pointerId);
    updateCursor();
    if (active !== 'grab') paint(p, p);
    requestFrame();
  });
  hit.addEventListener('pointermove', event => {
    trackCursor(event);
    if (!effect || !gesture || gesture.id !== event.pointerId) return;
    event.preventDefault();const p = point(event);
    if (gesture.tool === 'grab') effect.mesh.grab(gesture.start.x, gesture.start.y, p.x, p.y);
    else paint(gesture.last, p);
    gesture.last = p;requestFrame();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) hit.addEventListener(event, finishGesture);
  hit.addEventListener('contextmenu', event => event.preventDefault());
  hit.addEventListener('click', event => { event.preventDefault();event.stopPropagation(); });

  function frame(now) {
    raf = 0;
    if (!effect || document.hidden || stopped || !enabled || selecting || loading) return;
    const e = effect, rect = rectFor(), original = originalRect(e), initial = e.source.rect, region = e.source.region;
    updateCursor(rect);
    if ((e.target && !e.target.isConnected) || (region && (innerWidth !== region.viewportWidth || innerHeight !== region.viewportHeight)) || (e.source.capture && (Math.abs(original.width - initial.width) > 1 || Math.abs(original.height - initial.height) > 1)) || Math.abs(rect.width / rect.height - e.mesh.w / e.mesh.h) > .02) {
      releaseImage();notice(t('sizeChanged'));return;
    }
    const slice = e.source.slice;
    if (!region && e.source.capture && (slice.w < .999 || slice.h < .999) && (Math.max(0, original.left) < rect.left - 1 || Math.max(0, original.top) < rect.top - 1 || Math.min(innerWidth, original.left + original.width) > rect.left + rect.width + 1 || Math.min(innerHeight, original.top + original.height) > rect.top + rect.height + 1)) {
      releaseImage();notice(t('areaChanged'));return;
    }
    if (rect.left > innerWidth || rect.top > innerHeight || rect.left + rect.width < 0 || rect.top + rect.height < 0) { hit.hidden = true;canvas.style.visibility = 'hidden';lastTime = 0;return; }
    hit.hidden = false;canvas.style.visibility = '';locate(hit, rect);flushMask();
    // The effect lives at the image's document coordinates, with room for the
    // surface to deform. It must not introduce horizontal/vertical page overflow.
    const padding = Math.min(160, Math.min(rect.width, rect.height) * .4);
    const ratio = (devicePixelRatio || 1) * (visualViewport?.scale || 1);
    const vx = scrollX + (visualViewport?.offsetLeft || 0), vy = scrollY + (visualViewport?.offsetTop || 0);
    // Align the canvas to screen pixels too; a fractional CSS origin or backing
    // size would filter the already captured pixels again during compositing.
    const left = Math.ceil((Math.max(0, rect.left + scrollX - padding) - vx) * ratio) / ratio + vx;
    const top = Math.ceil((Math.max(0, rect.top + scrollY - padding) - vy) * ratio) / ratio + vy;
    const right = Math.floor((Math.min(document.documentElement.clientWidth, rect.left + scrollX + rect.width + padding) - vx) * ratio) / ratio + vx;
    const bottom = Math.floor((Math.min(Math.max(innerHeight, document.body.scrollHeight + document.body.getBoundingClientRect().top + scrollY), rect.top + scrollY + rect.height + padding) - vy) * ratio) / ratio + vy;
    const w = Math.max(1, Math.round((right - left) * ratio)), h = Math.max(1, Math.round((bottom - top) * ratio));
    const width = w / ratio, height = h / ratio;
    Object.assign(canvas.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w;canvas.height = h; }
    if (e.mesh.moving || e.mesh.gripState) {
      accumulator = Math.min(accumulator + (lastTime ? (now - lastTime) / 1000 : 1 / 60), 1 / 15);
      while (accumulator >= 1 / 120) { e.mesh.step(1 / 120, 0, params);accumulator -= 1 / 120; }
    }
    lastTime = now;
    renderer.draw(e.mesh, width, height, rect.width / e.mesh.w, rect.left + scrollX + rect.width / 2 - left - width / 2, rect.top + scrollY + rect.height / 2 - top - height / 2, tool !== 'grab', 'transparent', params);
    if (e.mesh.moving || e.mesh.gripState) requestFrame();
  }
  function pointerOver(event) {
    if (!enabled || !selecting || loading || event.composedPath().includes(host)) return;
    const hover = event.composedPath().find(isSource);
    highlight.hidden = !hover;
    if (hover) locate(highlight, hover.getBoundingClientRect());
  }
  function sourceAt(x, y) {
    const visited = new Set();
    function find(root) {
      if (visited.has(root)) return;
      visited.add(root);
      let source;
      for (const node of root.elementsFromPoint(x, y)) {
        if (node === host) continue;
        if (node.shadowRoot) source = find(node.shadowRoot);
        if (!source && isSource(node)) source = node;
        if (source) break;
      }
      if (source && source.getRootNode() !== root) return source;
      // Transparent input layers can cover a pointer-events:none canvas. Include
      // later canvases over earlier image elements in the same DOM tree too.
      return [...root.querySelectorAll('canvas')].reverse().find(node => {
        if (source && (node.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
        const r = node.getBoundingClientRect(), style = getComputedStyle(node);
        return r.width >= 8 && r.height >= 8 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && style.visibility !== 'hidden' && style.opacity !== '0';
      }) || source;
    }
    return find(document);
  }
  function finishSelection() {
    const ended = selection;selection = null;highlight.hidden = true;
    if (ended && $('picker').hasPointerCapture(ended.id)) $('picker').releasePointerCapture(ended.id);
  }
  function selectionRect(event) {
    const x = Math.max(0, Math.min(document.documentElement.clientWidth, event.clientX));
    const y = Math.max(0, Math.min(innerHeight, event.clientY));
    return { left: Math.min(selection.x, x), top: Math.min(selection.y, y), width: Math.abs(x - selection.x), height: Math.abs(y - selection.y) };
  }
  $('picker').onpointermove = event => {
    if (selection) {
      if (event.pointerId !== selection.id) return;
      selection.dragged ||= Math.hypot(event.clientX - selection.x, event.clientY - selection.y) >= 6;
      if (selection.dragged) { highlight.hidden = false;locate(highlight, selectionRect(event));return; }
    }
    const source = sourceAt(event.clientX, event.clientY);highlight.hidden = !source;
    if (source) locate(highlight, source.getBoundingClientRect());
  };
  $('picker').onpointerleave = () => { if (!selection) highlight.hidden = true; };
  $('picker').onpointerdown = event => {
    event.preventDefault();event.stopPropagation();
    if (event.button !== 0 || selection) return;
    selection = { id: event.pointerId, x: event.clientX, y: event.clientY, scrollX, scrollY, dragged: false };
    $('picker').setPointerCapture(event.pointerId);
  };
  $('picker').onpointerup = event => {
    if (!selection || event.pointerId !== selection.id) return;
    event.preventDefault();event.stopPropagation();
    const ended = selection, rect = selectionRect(event);
    const dragged = ended.dragged || Math.hypot(event.clientX - ended.x, event.clientY - ended.y) >= 6;
    finishSelection();
    if (ended.scrollX !== scrollX || ended.scrollY !== scrollY) return;
    if (dragged) { if (rect.width >= 8 && rect.height >= 8) void selectImage(null, rect); }
    else { const source = sourceAt(event.clientX, event.clientY);if (source) void selectImage(source); }
  };
  for (const type of ['pointercancel', 'lostpointercapture']) $('picker').addEventListener(type, finishSelection);
  $('picker').onclick = event => { event.preventDefault();event.stopPropagation(); };
  function pickImage(event) {
    if (!enabled || !selecting || loading || event.composedPath().includes(host)) return;
    const image = event.composedPath().find(isSource);
    if (!image) return;
    event.preventDefault();event.stopImmediatePropagation();void selectImage(image);
  }
  function keyDown(event) {
    const input = 'input:not([type="range"]):not([type="checkbox"]),textarea,[contenteditable],select';
    if (!enabled || loading || event.repeat || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || root.activeElement?.matches(input) || event.composedPath().some(node => node.matches?.(input))) return;
    if (event.key === 'Escape') {
      finishGesture();if (selecting) cancelSelection();return;
    }
    const key = event.key.toLowerCase();
    if (key === 'i') { event.preventDefault();event.stopImmediatePropagation();toggleSelection();return; }
    const next = TOOL_KEYS[key];
    if (effect && !selecting && next) { event.preventDefault();event.stopImmediatePropagation();setTool(next); }
  }
  $('select').onclick = toggleSelection;
  $('release').onclick = detachImage;
  function setFolded(folded) { $('panel').classList.toggle('folded', folded);$('fold').textContent = folded ? t('expand') : t('fold');$('fold').setAttribute('aria-expanded', String(!folded)); }
  $('fold').onclick = () => setFolded(!$('panel').classList.contains('folded'));
  $('enabled').onclick = () => {
    finishSelection();finishGesture();enabled = !enabled;lastTime = accumulator = 0;
    if (!enabled) {
      if (raf) cancelAnimationFrame(raf);raf = 0;highlight.hidden = true;
    }
    updateControls();if (enabled) requestFrame();
  };
  for (const button of root.querySelectorAll('[data-tool]')) button.onclick = () => setTool(button.dataset.tool);
  function syncParamControls() {
    for (const [id, key] of Object.entries(PARAM_FIELDS)) { $(id).value = params[key];$(id + 'Value').textContent = params[key] + (id === 'size' || id === 'grabRadius' ? ' px' : ''); }
  }
  for (const [id, key] of Object.entries(PARAM_FIELDS)) $(id).oninput = () => {
    params[key] = Number($(id).value);syncParamControls();updateCursor();
    if (Object.hasOwn(MATERIAL_PRESETS.jelly, key)) for (const button of root.querySelectorAll('[data-material]')) button.setAttribute('aria-pressed', 'false');
    if (effect) { effect.mesh.moving = true;requestFrame(); }
  };
  $('showGrabRange').onchange = () => updateCursor();
  for (const button of root.querySelectorAll('[data-material]')) button.onclick = () => {
    Object.assign(params, MATERIAL_PRESETS[button.dataset.material]);
    syncParamControls();
    for (const item of root.querySelectorAll('[data-material]')) item.setAttribute('aria-pressed', String(item === button));
    if (effect) { effect.mesh.moving = true;requestFrame(); }
  };
  $('fill').onclick = () => { if (!effect) return;effect.ctx.fillStyle = 'rgb(' + params.brushStrength + ',255,0)';effect.ctx.fillRect(0, 0, effect.mask.width, effect.mask.height);effect.dirty = true;requestFrame(); };
  $('clear').onclick = () => { if (!effect) return;effect.ctx.fillStyle = 'black';effect.ctx.fillRect(0, 0, effect.mask.width, effect.mask.height);effect.mesh.reset();effect.dirty = true;requestFrame(); };
  $('reset').onclick = () => { effect?.mesh.reset();requestFrame(); };
  function blur() { cursorPoint = null;finishSelection();finishGesture();updateCursor(); }
  function visibility() { lastTime = accumulator = 0;if (document.hidden) blur();else requestFrame(); }
  function cleanup() {
    stopped = true;generation++;finishSelection();releaseImage();if (raf) cancelAnimationFrame(raf);pageObserver.disconnect();imageObserver.disconnect();
    document.removeEventListener('pointermove', pointerOver, true);document.removeEventListener('click', pickImage, true);document.removeEventListener('keydown', keyDown, true);
    window.removeEventListener('scroll', requestFrame, true);window.removeEventListener('resize', requestFrame);window.removeEventListener('blur', blur);document.removeEventListener('visibilitychange', visibility);
    disposePanel();host.remove();delete globalThis.__nurupuruAnywhere;
  }
  $('close').onclick = cleanup;
  document.addEventListener('pointermove', pointerOver, true);document.addEventListener('click', pickImage, true);document.addEventListener('keydown', keyDown, true);
  window.addEventListener('scroll', requestFrame, true);window.addEventListener('resize', requestFrame);window.addEventListener('blur', blur);document.addEventListener('visibilitychange', visibility);
  globalThis.__nurupuruAnywhere = { wake() { setFolded(false);if (!effect && enabled && !loading && !selecting) chooseImage(); } };
  highlight.hidden = true;syncParamControls();notice(t('pickHint'));updateControls();
}
