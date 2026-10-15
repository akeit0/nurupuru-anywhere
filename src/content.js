import { SoftMesh } from './core/physics.js';
import { GLRenderer } from './core/renderer.js';
import { DEFAULT_PARAMS, MATERIAL_PRESETS } from './core/settings.js';
import { readSource, imageRect } from './source-image.js';
import { createPanel } from './panel.js';

const PARAM_FIELDS = { size: 'brushSize', strength: 'brushStrength', softness: 'softness', returnSpeed: 'returnSpeed', damping: 'damping' };
const TOOL_KEYS = { b: 'brush', e: 'erase', g: 'grab' };

if (globalThis.__nurupuruAnywhere) globalThis.__nurupuruAnywhere.wake();
else start();

function start() {
  const params = { ...DEFAULT_PARAMS, maskOpacity: 50, grabRadius: 240 };
  let tool = 'brush', effect = null, selecting = true, loading = false, generation = 0, stopped = false, enabled = true;
  let raf = 0, lastTime = 0, accumulator = 0, gesture = null;
  const { host, root, $, canvas, hit, highlight } = createPanel();
  let renderer;
  let message = '';
  function notice(text) { message = text;$('status').textContent = enabled ? message : 'OFF：元の画像を表示中';$('status').title = $('status').textContent; }
  function requestFrame() { if (!raf && !stopped && enabled && !document.hidden) raf = requestAnimationFrame(frame); }
  function rectFor(e = effect) {
    const r = imageRect(e.target), s = e.source.slice;
    return { left: r.left + r.width * s.x, top: r.top + r.height * s.y, width: r.width * s.w, height: r.height * s.h };
  }
  function locate(node, rect) {
    Object.assign(node.style, { left: rect.left + scrollX + 'px', top: rect.top + scrollY + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  }
  function setOriginalHidden(hidden) {
    if (!effect || hidden === effect.concealed) return;
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
    setOriginalHidden(false);effect?.target.removeEventListener('load', sourceChanged);imageObserver.disconnect();
    effect = null;hit.hidden = true;lastTime = accumulator = 0;
    renderer?.dispose();renderer = null;canvas.width = canvas.width;
    updateControls();
  }
  function sourceChanged() { releaseImage();notice('画像が変わりました。「画像を選ぶ」で選び直してください。'); }
  const imageObserver = new ResizeObserver(requestFrame);
  const pageObserver = new MutationObserver(() => {
    if (effect && !effect.target.isConnected) sourceChanged();
    else if (effect) requestFrame();
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });

  function chooseImage() {
    finishGesture();generation++;selecting = true;highlight.hidden = true;
    notice('ページの画像をクリック');updateControls();
  }
  function cancelSelection() {
    selecting = false;highlight.hidden = true;updateControls();requestFrame();
    notice(effect ? toolHelp() : '画像を選んで開始');
  }
  function detachImage() {
    generation++;loading = false;selecting = false;highlight.hidden = true;releaseImage();
    notice('画像を解除しました');
  }
  function toolHelp() { return tool === 'grab' ? '塗った部分を引っぱって離す' : tool === 'erase' ? '動かさない部分の塗りを消す' : '動かす部分を塗って「つかむ」へ'; }
  function updateControls() {
    const state = !enabled ? 'off' : loading ? 'loading' : selecting ? 'selecting' : effect ? tool : 'idle';
    $('panel').dataset.state = state;
    $('enabled').textContent = enabled ? 'ON' : 'OFF';$('enabled').setAttribute('aria-pressed', String(enabled));$('enabled').title = enabled ? '効果を一時停止' : '効果を再開';
    $('selectLabel').textContent = loading ? '読み込み中…' : selecting ? '画像を選択中' : effect ? '画像を変更' : '画像を選ぶ';
    $('selectHint').textContent = selecting ? '中止' : effect?.target.alt || '';
    $('select').setAttribute('aria-pressed', String(selecting));
    $('select').title = selecting ? 'ページ上の画像をクリック。もう一度押すと選択を中止。' : effect ? '画像を変更：' + (effect.target.alt || '選択した画像') : 'ページ上の画像を選ぶ';
    $('select').disabled = loading || !enabled;
    $('release').hidden = !effect && !loading;
    $('editing').hidden = !effect;
    $('editing').disabled = !enabled || selecting || loading;
    $('brush').hidden = tool === 'grab';
    $('grab').hidden = tool !== 'grab';
    $('strengthRow').hidden = tool !== 'brush';
    for (const button of root.querySelectorAll('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
    const active = enabled && !selecting && !loading && !!effect;
    setOriginalHidden(active);
    hit.hidden = !active;canvas.style.visibility = active ? '' : 'hidden';
    notice(message);
    hit.style.cursor = tool === 'grab' ? 'grab' : 'crosshair';
  }
  function setTool(next) {
    finishGesture();tool = next;updateControls();requestFrame();
    if (effect) notice(toolHelp());
  }
  async function selectImage(target) {
    if (loading) return;
    const job = ++generation;loading = true;selecting = false;highlight.hidden = true;updateControls();
    try {
      const source = await readSource(target, host);
      if (job !== generation || stopped) return;
      if (!target.isConnected) throw Error('画像がページから取り除かれました。選び直してください。');
      releaseImage();
      const image = source.image, mask = document.createElement('canvas');
      mask.dataset.maskChannel = 'red';
      const scale = Math.min(1, 640 / Math.max(image.width, image.height));
      mask.width = Math.max(2, Math.round(image.width * scale));mask.height = Math.max(2, Math.round(image.height * scale));
      const ctx = mask.getContext('2d', { willReadFrequently: true });ctx.fillStyle = 'black';ctx.fillRect(0, 0, mask.width, mask.height);
      const mesh = new SoftMesh(image.width, image.height, 'eco');mesh.sampleMask(ctx, mask.width, mask.height);
      renderer = new GLRenderer(canvas);renderer.updateImage(image, mask, mesh);
      effect = { target, source, mask, ctx, mesh, dirty: false, revision: 0, concealed: false };
      target.addEventListener('load', sourceChanged);imageObserver.observe(target);
      setTool('brush');
      notice(source.capture ? '表示中の画像を取得しました。動かしたいところを塗ってください。' : '動かしたいところを塗り、「つかむ」で引っぱってください。');
      requestFrame();
    } catch (error) {
      if (job !== generation || stopped) return;
      if (!effect) releaseImage();
      notice(error.message || '画像を読み込めませんでした。');selecting = true;
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
    flushMask();requestFrame();
  }
  hit.addEventListener('pointerdown', event => {
    if (!enabled || selecting || loading || !effect || gesture || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault();event.stopPropagation();
    const p = point(event), active = event.button === 2 && tool === 'brush' ? 'erase' : tool;
    flushMask();
    if (active === 'grab') {
      params.grabRadius = Math.min(720, 110 / p.zoom / effect.mesh.scale * 720);
      if (!effect.mesh.beginGrab(p.x, p.y, 'grab', params)) { notice('先に動かしたいところを塗ってください。');return; }
    }
    gesture = { id: event.pointerId, tool: active, start: p, last: p };hit.setPointerCapture(event.pointerId);
    if (active !== 'grab') paint(p, p);
    requestFrame();
  });
  hit.addEventListener('pointermove', event => {
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
    const e = effect, rect = rectFor(), original = imageRect(e.target), initial = e.source.rect;
    if (!e.target.isConnected || (e.source.capture && (Math.abs(original.width - initial.width) > 1 || Math.abs(original.height - initial.height) > 1)) || Math.abs(rect.width / rect.height - e.mesh.w / e.mesh.h) > .02) {
      releaseImage();notice('画像の表示サイズが変わりました。選び直してください。');return;
    }
    const slice = e.source.slice;
    if (e.source.capture && (slice.w < .999 || slice.h < .999) && (Math.max(0, original.left) < rect.left - 1 || Math.max(0, original.top) < rect.top - 1 || Math.min(innerWidth, original.left + original.width) > rect.left + rect.width + 1 || Math.min(innerHeight, original.top + original.height) > rect.top + rect.height + 1)) {
      releaseImage();notice('画像の表示範囲が変わりました。選び直してください。');return;
    }
    if (rect.left > innerWidth || rect.top > innerHeight || rect.left + rect.width < 0 || rect.top + rect.height < 0) { hit.hidden = true;canvas.style.visibility = 'hidden';lastTime = 0;return; }
    hit.hidden = false;canvas.style.visibility = '';locate(hit, rect);flushMask();
    // The effect lives at the image's document coordinates, with room for the
    // surface to deform. It must not introduce horizontal/vertical page overflow.
    const padding = Math.min(160, Math.min(rect.width, rect.height) * .4);
    const left = Math.max(0, rect.left + scrollX - padding), top = Math.max(0, rect.top + scrollY - padding);
    const right = Math.min(document.documentElement.clientWidth, rect.left + scrollX + rect.width + padding);
    const bottom = Math.min(Math.max(innerHeight, document.body.scrollHeight + document.body.getBoundingClientRect().top + scrollY), rect.top + scrollY + rect.height + padding);
    const width = Math.max(1, right - left), height = Math.max(1, bottom - top);
    Object.assign(canvas.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
    const ratio = Math.min(devicePixelRatio || 1, 2), w = Math.round(width * ratio), h = Math.round(height * ratio);
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
    const hover = event.composedPath().find(node => node instanceof HTMLImageElement);
    highlight.hidden = !hover;
    if (hover) locate(highlight, hover.getBoundingClientRect());
  }
  function pickImage(event) {
    if (!enabled || !selecting || loading || event.composedPath().includes(host)) return;
    const image = event.composedPath().find(node => node instanceof HTMLImageElement);
    if (!image) return;
    event.preventDefault();event.stopImmediatePropagation();void selectImage(image);
  }
  function keyDown(event) {
    if (!enabled || loading || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.composedPath().some(node => node.matches?.('input,textarea,[contenteditable],select'))) return;
    if (event.key === 'Escape') {
      finishGesture();if (selecting) cancelSelection();return;
    }
    const next = TOOL_KEYS[event.key.toLowerCase()];
    if (effect && !selecting && next) { event.preventDefault();event.stopImmediatePropagation();setTool(next); }
  }
  $('select').onclick = () => selecting ? cancelSelection() : chooseImage();
  $('release').onclick = detachImage;
  function setFolded(folded) { $('panel').classList.toggle('folded', folded);$('fold').textContent = folded ? '開く' : '畳む';$('fold').setAttribute('aria-expanded', String(!folded)); }
  $('fold').onclick = () => setFolded(!$('panel').classList.contains('folded'));
  $('enabled').onclick = () => {
    finishGesture();enabled = !enabled;lastTime = accumulator = 0;
    if (!enabled) {
      if (raf) cancelAnimationFrame(raf);raf = 0;highlight.hidden = true;
    }
    updateControls();if (enabled) requestFrame();
  };
  for (const button of root.querySelectorAll('[data-tool]')) button.onclick = () => setTool(button.dataset.tool);
  function syncParamControls() {
    for (const [id, key] of Object.entries(PARAM_FIELDS)) { $(id).value = params[key];$(id + 'Value').textContent = params[key] + (id === 'size' ? ' px' : ''); }
  }
  for (const [id, key] of Object.entries(PARAM_FIELDS)) $(id).oninput = () => {
    params[key] = Number($(id).value);syncParamControls();
    if (Object.hasOwn(MATERIAL_PRESETS.jelly, key)) for (const button of root.querySelectorAll('[data-material]')) button.setAttribute('aria-pressed', 'false');
    if (effect) { effect.mesh.moving = true;requestFrame(); }
  };
  for (const button of root.querySelectorAll('[data-material]')) button.onclick = () => {
    Object.assign(params, MATERIAL_PRESETS[button.dataset.material]);
    syncParamControls();
    for (const item of root.querySelectorAll('[data-material]')) item.setAttribute('aria-pressed', String(item === button));
    if (effect) { effect.mesh.moving = true;requestFrame(); }
  };
  $('fill').onclick = () => { if (!effect) return;effect.ctx.fillStyle = 'rgb(' + params.brushStrength + ',255,0)';effect.ctx.fillRect(0, 0, effect.mask.width, effect.mask.height);effect.dirty = true;requestFrame(); };
  $('clear').onclick = () => { if (!effect) return;effect.ctx.fillStyle = 'black';effect.ctx.fillRect(0, 0, effect.mask.width, effect.mask.height);effect.mesh.reset();effect.dirty = true;requestFrame(); };
  $('reset').onclick = () => { effect?.mesh.reset();requestFrame(); };
  function visibility() { lastTime = accumulator = 0;if (document.hidden) finishGesture();else requestFrame(); }
  function cleanup() {
    stopped = true;generation++;releaseImage();if (raf) cancelAnimationFrame(raf);pageObserver.disconnect();imageObserver.disconnect();
    document.removeEventListener('pointermove', pointerOver, true);document.removeEventListener('click', pickImage, true);document.removeEventListener('keydown', keyDown, true);
    window.removeEventListener('scroll', requestFrame, true);window.removeEventListener('resize', requestFrame);window.removeEventListener('blur', finishGesture);document.removeEventListener('visibilitychange', visibility);
    host.remove();delete globalThis.__nurupuruAnywhere;
  }
  $('close').onclick = cleanup;
  document.addEventListener('pointermove', pointerOver, true);document.addEventListener('click', pickImage, true);document.addEventListener('keydown', keyDown, true);
  window.addEventListener('scroll', requestFrame, true);window.addEventListener('resize', requestFrame);window.addEventListener('blur', finishGesture);document.addEventListener('visibilitychange', visibility);
  globalThis.__nurupuruAnywhere = { wake() { setFolded(false);if (!effect && enabled && !loading && !selecting) chooseImage(); } };
  highlight.hidden = true;syncParamControls();notice('ページの画像をクリック');updateControls();
}
