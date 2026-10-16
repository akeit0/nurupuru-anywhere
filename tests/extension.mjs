import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { closedUI } from './closed-shadow.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const locale = process.argv[2] || 'ja-JP', language = locale.startsWith('ja') ? 'ja' : 'en';
const messages = JSON.parse(await readFile(path.join(root, '_locales', language, 'messages.json'), 'utf8'));
const t = key => messages[key].message;
const manifest = JSON.parse(await readFile(path.join(root, 'dist/manifest.json'), 'utf8'));
assert.equal(manifest.default_locale, 'en');
for (const lang of ['ja', 'en']) {
  const packaged = JSON.parse(await readFile(path.join(root, 'dist/_locales', lang, 'messages.json'), 'utf8'));
  assert.deepEqual(Object.keys(packaged).sort(), Object.keys(messages).sort());
}
assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);assert.equal(manifest.host_permissions, undefined);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#d5baff"/><stop offset="1" stop-color="#8870d5"/></linearGradient></defs><ellipse cx="200" cy="150" rx="150" ry="125" fill="url(#g)"/><circle cx="155" cy="150" r="10" fill="#342945"/><circle cx="245" cy="150" r="10" fill="#342945"/><path d="M177 174q23 28 46 0" stroke="#342945" stroke-width="7" fill="none"/></svg>';
let foreignRequests = 0;
const foreign = http.createServer((req, res) => { foreignRequests++;res.writeHead(200, { 'Content-Type': 'image/svg+xml' });res.end(svg); });
await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
const other = 'http://127.0.0.1:' + foreign.address().port;
const server = http.createServer((req, res) => {
  if (req.url === '/image.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' });res.end(svg);return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; require-trusted-types-for 'script'; trusted-types 'none'; img-src 'self' " + other });
  res.end('<!doctype html><meta charset="utf-8"><title>Image fixtures</title><style>body{margin:32px;background:#f9f5ee;color:#302941;font:16px system-ui}h1{font-size:24px}main{display:flex;gap:40px}img{display:block;width:400px;height:300px}a{display:block}.spacer{height:1200px}</style><h1>ページ上の画像で、ぬるぷる。</h1><p>このページの画像を選んで動かします。</p><main><a href="/navigated"><img id="first" src="/image.svg"></a><img id="foreign" src="' + other + '/image.svg"></main><div class="spacer"></div>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir(path.join(root, 'test-results'), { recursive: true });
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, locale,
  args: ['--lang=' + locale, '--disable-extensions-except=' + path.join(root, 'dist'), '--load-extension=' + path.join(root, 'dist'), '--enable-unsafe-extension-debugging', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  assert.equal(await worker.evaluate(() => chrome.action.onClicked.hasListeners()), true, 'service worker is ready');
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    globalThis.pageShadowRoots = [];
    Element.prototype.attachShadow = function (options) { const root = attach.call(this, options);pageShadowRoots.push(root);return root; };
    globalThis.pageInternalEvents = [];
    document.addEventListener('pointerdown', event => {
      if (event.target.id === 'nurupuru-anywhere') pageInternalEvents.push(event.composedPath().some(node => node.id === 'hit' || node instanceof HTMLCanvasElement));
    }, true);
  });
  await page.goto('http://127.0.0.1:' + server.address().port);
  const browserCdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const tab = targetInfos.find(target => target.url === page.url());
  assert.ok(tab, 'fixture tab target exists');
  const activate = () => browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
  await activate();
  await page.waitForSelector('#nurupuru-anywhere', { state: 'attached', timeout: 10000 }).catch(async error => {
    console.log({ errors, tabs: await worker.evaluate(async () => { const tabs = await chrome.tabs.query({ active: true });return Promise.all(tabs.map(async tab => ({ id: tab.id, url: tab.url, badge: await chrome.action.getBadgeText({ tabId: tab.id }), title: await chrome.action.getTitle({ tabId: tab.id }) }))); }) });throw error;
  });
  const panel = page.locator('#nurupuru-anywhere');
  const closed = await closedUI(page), { ui, control } = closed;
  assert.equal((await worker.evaluate(() => chrome.i18n.getUILanguage())).split('-')[0], language);
  assert.equal(await worker.evaluate(() => chrome.i18n.getMessage('extensionDescription')), t('extensionDescription'));
  assert.equal(await worker.evaluate(() => chrome.action.getTitle({})), t('actionTitle'));
  assert.equal(await ui('panel').getAttribute('lang'), language);
  assert.equal(await control('header strong').textContent(), t('brand') + ' Anywhere');
  assert.equal(await ui('panel').getAttribute('data-state'), 'selecting');
  assert.equal(await ui('editing').isVisible(), false, 'start with image selection before exposing editing controls');
  await page.keyboard.press('i');assert.equal(await ui('panel').getAttribute('data-state'), 'idle');
  await page.keyboard.press('i');assert.equal(await ui('panel').getAttribute('data-state'), 'selecting', 'I starts selection without an existing image');
  const positions = () => ui('canvas').evaluate(canvas => {
    const g = canvas.getContext('webgl2'), size = g.getBufferParameter(g.ARRAY_BUFFER, g.BUFFER_SIZE), data = new Float32Array(size / 4);
    g.getBufferSubData(g.ARRAY_BUFFER, 0, data);return [...data];
  });
  const pixel = async point => {
    const png = await page.screenshot({ clip: { x: Math.floor(point.x), y: Math.floor(point.y), width: 1, height: 1 } });
    return page.evaluate(async data => { const image = await createImageBitmap(new Blob([Uint8Array.from(atob(data), x => x.charCodeAt(0))], { type: 'image/png' }));const canvas = document.createElement('canvas');canvas.width = canvas.height = 1;const g = canvas.getContext('2d');g.drawImage(image, 0, 0);image.close();return [...g.getImageData(0, 0, 1, 1).data]; }, png.toString('base64'));
  };
  const painted = async (tool, from, to) => {
    await control('[data-tool=' + tool + ']').click();await page.mouse.move(from.x, from.y);await page.mouse.down();await page.mouse.move(to.x, to.y, { steps: 12 });await page.mouse.up();
  };
  await page.locator('#first').click();
  await page.waitForFunction(() => document.getElementById('first').style.opacity === '0');
  assert.ok(!page.url().endsWith('/navigated'), 'selecting a linked image does not navigate');
  await ui('hit').waitFor({ state: 'visible' });
  assert.equal(await ui('panel').getAttribute('data-state'), 'brush');
  const brushColor = await ui('panel').evaluate(el => getComputedStyle(el).getPropertyValue('--accent'));
  await page.waitForTimeout(100);
  const rect = await ui('hit').boundingBox(), center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const rest = await positions();assert.ok(rest.length > 1000 && rest.every(Number.isFinite));
  await painted('grab', center, { x: center.x + 50, y: center.y });
  assert.equal(await ui('status').textContent(), t('paintFirst'));assert.deepEqual(await positions(), rest, 'an empty mask cannot be grabbed');
  assert.equal(await ui('grabRadius').inputValue(), '110');
  assert.equal(await ui('grabRadiusValue').textContent(), '110 px');
  const unpainted = await pixel(center);
  await ui('strength').evaluate(el => { el.value = '120';el.dispatchEvent(new Event('input')); });
  await control('[data-tool=brush]').click();await ui('strength').focus();
  await page.keyboard.press('ArrowLeft');assert.equal(await ui('strength').inputValue(), '119');
  await page.keyboard.press('ArrowRight');assert.equal(await ui('strength').inputValue(), '120');
  await page.keyboard.press('g');
  assert.equal(await ui('panel').getAttribute('data-state'), 'grab', 'G works immediately after adjusting a slider');
  await ui('grabRadius').focus();await page.keyboard.press('b');
  assert.equal(await ui('panel').getAttribute('data-state'), 'brush', 'B works from the grab radius slider');
  await ui('size').focus();await page.keyboard.press('e');
  assert.equal(await ui('panel').getAttribute('data-state'), 'erase', 'E works from the brush size slider');
  await ui('size').focus();await page.keyboard.press('i');
  assert.equal(await ui('panel').getAttribute('data-state'), 'selecting', 'I works from the brush size slider');
  await page.keyboard.press('Escape');await ui('hit').waitFor({ state: 'visible' });
  await painted('brush', { x: center.x - 50, y: center.y }, { x: center.x + 50, y: center.y });
  assert.notDeepEqual(await pixel(center), unpainted, 'paint displays the mask');
  await control('[data-tool=grab]').click();await page.mouse.move(center.x, center.y);await page.mouse.down();await page.mouse.move(center.x + 90, center.y + 60, { steps: 16 });await page.waitForTimeout(200);
  const pulled = await positions();assert.ok(pulled.some((value, index) => Math.abs(value - rest[index]) > 1), 'painted mesh deforms while dragging');
  await page.mouse.up();await page.waitForTimeout(150);
  const released = await positions();assert.ok(released.every(Number.isFinite));assert.notDeepEqual(released, pulled, 'release animates recoil');
  await page.screenshot({ path: path.join(root, 'test-results/interaction.png') });
  await ui('reset').click();await page.waitForTimeout(100);assert.deepEqual(await positions(), rest, 'reset restores the rest shape');
  await control('[data-tool=brush]').click();await ui('clear').click();await page.waitForTimeout(100);await painted('grab', center, { x: center.x + 30, y: center.y });assert.equal(await ui('status').textContent(), t('paintFirst'));
  assert.notEqual(await ui('panel').evaluate(el => getComputedStyle(el).getPropertyValue('--accent')), brushColor, 'grab has its own visible state color');
  await control('[data-tool=brush]').click();
  await ui('strength').evaluate(el => { el.value = '255';el.dispatchEvent(new Event('input')); });
  await ui('fill').click();await control('[data-tool=grab]').click();
  async function pullWithRadius(radius) {
    await ui('reset').click();await page.waitForTimeout(100);
    await ui('grabRadius').evaluate((el, value) => { el.value = value;el.dispatchEvent(new Event('input')); }, String(radius));
    assert.equal(await ui('grabRadiusValue').textContent(), radius + ' px');
    await page.mouse.move(center.x, center.y);await page.mouse.down();await page.mouse.move(center.x + 60, center.y, { steps: 12 });await page.waitForTimeout(200);
    const moved = await positions();await page.mouse.up();
    let sum = 0, count = 0;
    for (let i = 0; i < rest.length; i += 2) {
      const distance = Math.hypot(rest[i] - 200, rest[i + 1] - 150);
      if (distance >= 80 && distance <= 130) { sum += Math.hypot(moved[i] - rest[i], moved[i + 1] - rest[i + 1]);count++; }
    }
    return sum / count;
  }
  const narrowPull = await pullWithRadius(35), widePull = await pullWithRadius(180);
  assert.ok(widePull > narrowPull * 1.5, `a wider grab radius moves more distant vertices: ${narrowPull} vs ${widePull}`);
  await ui('reset').click();await control('[data-tool=brush]').click();await ui('clear').click();await control('[data-tool=grab]').click();
  await ui('strength').evaluate(el => { el.value = '120';el.dispatchEvent(new Event('input')); });
  await page.evaluate(() => { const input = document.createElement('input');input.id = 'typing';document.body.append(input);input.focus(); });
  await page.keyboard.press('i');assert.equal(await page.locator('#typing').inputValue(), 'i');
  assert.equal(await ui('panel').getAttribute('data-state'), 'grab', 'typing in a page input does not change images');
  await page.locator('#typing').evaluate(el => el.remove());
  await page.keyboard.down('i');assert.equal(await page.locator('#first').evaluate(el => el.style.opacity), '');
  await page.keyboard.down('i');assert.equal(await ui('panel').getAttribute('data-state'), 'selecting', 'holding I does not repeatedly toggle selection');
  await page.keyboard.up('i');await page.keyboard.press('i');await ui('hit').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#first').evaluate(el => el.style.opacity), '0', 'I cancels image change and restores the effect');
  await page.keyboard.press('i');
  await page.keyboard.press('Escape');await ui('hit').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#first').evaluate(el => el.style.opacity), '0', 'canceling image change restores the existing effect');
  await ui('material').locator('summary').click();await control('[data-material=soft]').click();assert.equal(await ui('softness').inputValue(), '75');
  await page.keyboard.press('i');assert.equal(await page.locator('#first').evaluate(el => el.style.opacity), '', 'switching image restores the previous element');
  const requests = foreignRequests;await page.locator('#foreign').click();
  await page.waitForFunction(() => document.getElementById('foreign').style.opacity === '0', { timeout: 15000 });
  assert.equal(await ui('status').textContent(), t('captured'), 'cross-origin image uses real captureVisibleTab');
  assert.equal(foreignRequests, requests, 'extension does not re-download the image');
  const exposure = await page.evaluate(() => {
    const image = document.getElementById('foreign'), sample = document.createElement('canvas');
    sample.width = 400;sample.height = 300;const ctx = sample.getContext('2d');ctx.drawImage(image, 0, 0);
    let directRead;
    try { ctx.getImageData(0, 0, 1, 1);directRead = 'allowed'; } catch (error) { directRead = error.name; }
    const host = document.getElementById('nurupuru-anywhere');
    const root = host.shadowRoot, canvas = root?.querySelector('canvas') || host.querySelector('canvas');
    let screenshotPixel = null;
    if (canvas) {
      const g = canvas.getContext('webgl2'), unit = g.getParameter(g.ACTIVE_TEXTURE), previous = g.getParameter(g.FRAMEBUFFER_BINDING);
      g.activeTexture(g.TEXTURE0);const texture = g.getParameter(g.TEXTURE_BINDING_2D), fb = g.createFramebuffer();
      g.bindFramebuffer(g.FRAMEBUFFER, fb);g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, texture, 0);
      const pixel = new Uint8Array(4);g.readPixels(200, 150, 1, 1, g.RGBA, g.UNSIGNED_BYTE, pixel);screenshotPixel = [...pixel];
      g.bindFramebuffer(g.FRAMEBUFFER, previous);g.deleteFramebuffer(fb);g.activeTexture(unit);
    }
    return {
      directRead, rootAccessible: root !== null, screenshotPixel,
      nativeRootAccessible: Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot').get.call(host) !== null,
      creationIntercepted: pageShadowRoots.length > 0,
      internalEventsObserved: pageInternalEvents.length > 0, internalEventLeaked: pageInternalEvents.some(Boolean),
      controllerVisible: typeof globalThis.__nurupuruAnywhere !== 'undefined', debugHookVisible: typeof globalThis.__nurupuruTestRoot !== 'undefined',
    };
  });
  assert.deepEqual(exposure, {
    directRead: 'SecurityError', rootAccessible: false, screenshotPixel: null, nativeRootAccessible: false, creationIntercepted: false,
    internalEventsObserved: true, internalEventLeaked: false, controllerVisible: false, debugHookVisible: false,
  }, 'page scripts cannot access captured cross-origin pixels through DOM, native getters, prototype interception, events or global handles');
  assert.equal(await ui('strength').inputValue(), '120');assert.equal(await ui('softness').inputValue(), '75', 'settings are shared across image selections');
  assert.equal(await ui('grabRadius').inputValue(), '180', 'grab radius is preserved when changing images');
  assert.equal(await control('canvas').count(), 1, 'only one image renderer exists');
  await ui('fill').click();await control('[data-tool=grab]').click();await page.screenshot({ path: path.join(root, 'test-results/panel.png') });
  await page.evaluate(() => scrollBy(0, 120));await page.waitForTimeout(100);
  const tracked = await ui('hit').boundingBox(), imageBox = await page.locator('#foreign').boundingBox();assert.ok(Math.abs(tracked.y - imageBox.y) < 1, 'overlay follows scrolling');
  assert.equal(await ui('canvas').evaluate(el => getComputedStyle(el).position), 'absolute', 'effect is anchored in the document, not fixed to the screen');
  await ui('fold').click();assert.equal(await ui('detail').isVisible(), false);assert.equal(await ui('enabled').isVisible(), true);assert.equal(await ui('release').isVisible(), true, 'image removal remains accessible while folded');assert.equal(await ui('close').textContent(), t('close'));
  await ui('enabled').click();assert.equal(await ui('enabled').textContent(), 'OFF');assert.equal(await page.locator('#foreign').evaluate(el => el.style.opacity), '');assert.equal(await ui('hit').isVisible(), false, 'OFF restores normal page interaction');
  assert.equal(await ui('panel').getAttribute('data-state'), 'off');assert.match(await ui('status').textContent(), /OFF/);
  await page.locator('#foreign').evaluate(el => el.style.setProperty('opacity', '.6', 'important'));
  await ui('enabled').click();await ui('hit').waitFor({ state: 'visible' });assert.equal(await page.locator('#foreign').evaluate(el => el.style.opacity), '0');
  await activate();await ui('detail').waitFor({ state: 'visible' });assert.equal(await ui('softness').inputValue(), '75');assert.equal(await page.locator('#foreign').evaluate(el => el.style.opacity), '0', 'reopening preserves the selected image');
  await ui('release').click();assert.equal(await panel.count(), 1, 'releasing the image keeps the extension open');
  assert.equal(await page.locator('#foreign').evaluate(el => el.style.opacity), '0.6', 'page opacity changes while OFF survive re-enabling and release');
  assert.equal(await page.locator('#foreign').evaluate(el => el.style.getPropertyPriority('opacity')), 'important');
  assert.equal(await ui('editing').isVisible(), false);assert.equal(await ui('panel').getAttribute('data-state'), 'idle');
  assert.equal(await ui('selectLabel').textContent(), t('selectImage'));assert.equal(await ui('softness').inputValue(), '75', 'release preserves shared settings');
  assert.equal(await ui('grabRadius').inputValue(), '180', 'release preserves the grab radius');
  await ui('select').click();await page.locator('#first').click();await ui('hit').waitFor({ state: 'visible' });
  await ui('close').click();assert.equal(await page.locator('#nurupuru-anywhere').count(), 0);assert.equal(await page.locator('#foreign').evaluate(el => el.style.opacity), '0.6', 'closing preserves the previously released image');
  assert.equal(await page.locator('#first').evaluate(el => el.style.opacity), '', 'closing also removes the current image effect');
  await activate();await page.waitForSelector('#nurupuru-anywhere', { state: 'attached' });await closed.refresh();await ui('fold').click();await activate();
  await closed.waitFor(root => root.getElementById('fold').getAttribute('aria-expanded') === 'true');
  assert.equal(await page.locator('#nurupuru-anywhere').count(), 1, 'repeated toolbar activation does not duplicate controls');
  await closed.evaluate(root => { document.getElementById('foreign').click();root.getElementById('release').click(); });
  await page.waitForTimeout(700);
  assert.equal(await ui('panel').getAttribute('data-state'), 'idle', 'a canceled pending capture cannot reselect the image');
  assert.equal(await page.locator('#foreign').evaluate(el => el.style.opacity), '0.6');
  await ui('select').click();await page.evaluate(() => document.getElementById('foreign').click());
  await page.setViewportSize({ width: 1180, height: 900 });
  await closed.waitFor((root, expected) => root.getElementById('status').textContent === expected, t('captureChanged'));
  assert.equal(await ui('editing').isVisible(), false, 'a resized capture is rejected instead of applying misaligned pixels');
  await closed.evaluate(root => { document.getElementById('foreign').click();root.getElementById('close').click(); });
  await page.waitForTimeout(700);assert.equal(await panel.count(), 0, 'closing during capture cannot recreate the extension UI');
  await activate();await page.waitForSelector('#nurupuru-anywhere', { state: 'attached' });await closed.refresh();
  await page.locator('#first').click();await ui('hit').waitFor({ state: 'visible' });
  await page.locator('#first').evaluate(el => el.remove());
  await closed.waitFor(root => root.getElementById('panel').dataset.state === 'idle');
  assert.equal(await ui('editing').isVisible(), false, 'removing the selected source releases its effect');
  await ui('close').click();
  assert.deepEqual(errors, []);
  console.log('PASS (' + locale + '): unpacked extension, page-world screenshot isolation, CSP, direct/captured images, mask/physics, shared settings, positioning, OFF/style restoration, canceled captures, viewport changes and teardown');
} finally { await context.close();await new Promise(resolve => server.close(resolve));await new Promise(resolve => foreign.close(resolve)); }
