import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { closedUI } from './closed-shadow.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><defs><pattern id="p" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#eee"/><path d="M0 0H12V12" fill="none" stroke="#161616" stroke-width="1"/></pattern></defs><rect width="1000" height="700" fill="url(#p)"/><circle cx="300" cy="230" r="140" fill="#a66ed5"/><text x="140" y="480" font-size="40">Capture 012345 ABCDE</text></svg>';
const foreign = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/svg+xml' });res.end(svg); });
await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
const server = http.createServer((req, res) => {
  const partial = req.url === '/partial';
  const quirks = req.url === '/quirks', scroll = req.url === '/scroll';
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`${quirks ? '' : '<!doctype html>'}<style>${scroll ? 'html{overflow:scroll}' : ''}body{margin:0;height:2400px;background:#eee}img{position:absolute;left:${partial ? -90.3 : 170.3}px;top:${partial ? -20.4 : 120.4}px;width:900.4px;height:550.6px}</style><img src="http://127.0.0.1:${foreign.address().port}/image.svg">`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const [density, zoom, mode = ''] of [[1, 1], [1.25, 1.1], [2, 1], [3, 1], [1.25, 1.1, 'partial'], [1.25, 1.1, 'scroll'], [1, 1, 'quirks'], [1.25, 1.1, 'region'], [2, 1, 'region']]) {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, deviceScaleFactor: density,
      // captureVisibleTab uses the browser's display scale, not just CDP emulation.
      ignoreDefaultArgs: ['--hide-scrollbars'],
      args: ['--force-device-scale-factor=' + density, '--disable-extensions-except=' + path.join(root, 'dist'), '--load-extension=' + path.join(root, 'dist'), '--enable-unsafe-extension-debugging', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://127.0.0.1:' + server.address().port + '/' + mode);
      await page.locator('img').evaluate(el => el.decode());
      if (zoom !== 1) await worker.evaluate(value => chrome.tabs.setZoom(value), zoom);
      const cdp = await context.browser().newBrowserCDPSession();
      const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
      await cdp.send('Extensions.triggerAction', { id: worker.url().split('/')[2], targetId: targetInfos.find(tab => tab.url === page.url()).targetId });
      await page.locator('#nurupuru-anywhere').waitFor({ state: 'attached' });
      const { ui, control } = await closedUI(page);
      await ui('panel').evaluate(el => el.style.visibility = 'hidden');
      await page.mouse.move(20, 800);
      const before = await page.screenshot();let rect = await page.locator('img').boundingBox();
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio }));
      if (mode === 'region') {
        rect = { x: rect.x + 50.3, y: rect.y + 70.4, width: 500.4, height: 300.6 };
        await page.mouse.move(rect.x, rect.y);await page.mouse.down();
        await page.mouse.move(rect.x + rect.width, rect.y + rect.height, { steps: 8 });await page.mouse.up();
      } else await page.mouse.click(Math.max(10, rect.x + rect.width / 2), Math.max(10, rect.y + rect.height / 2));
      await ui('hit').waitFor({ state: 'visible' });
      assert.equal(await ui('status').textContent(), await worker.evaluate(key => chrome.i18n.getMessage(key), mode === 'region' ? 'regionCaptured' : 'captured'), 'the test must exercise tab capture');
      await control('[data-tool=grab]').evaluate(el => el.click());
      await page.mouse.move(20, 800);
      await page.waitForTimeout(100);
      const after = await page.screenshot();
      // Compare the final composited result to the original page, including text
      // and fine lines. Merely checking the crop size misses filtering/phase errors.
      const mae = await page.evaluate(async ({ before, after, rect, viewport }) => {
        async function pixels(data) {
          const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
          const c = document.createElement('canvas');c.width = bitmap.width;c.height = bitmap.height;
          const g = c.getContext('2d');g.drawImage(bitmap, 0, 0);bitmap.close();
          return { data: g.getImageData(0, 0, c.width, c.height).data, width: c.width };
        }
        const a = await pixels(before), b = await pixels(after), ratio = viewport.ratio;
        const left = Math.ceil((Math.max(0, rect.x) + 20) * ratio), top = Math.ceil((Math.max(0, rect.y) + 20) * ratio);
        const right = Math.floor((Math.min(viewport.width, rect.x + rect.width) - 20) * ratio), bottom = Math.floor((Math.min(viewport.height, rect.y + rect.height) - 20) * ratio);
        let error = 0, count = 0;
        for (let y = top; y < bottom; y += 2) for (let x = left; x < right; x += 2) {
          const offset = (y * a.width + x) * 4;
          for (let channel = 0; channel < 3; channel++) { error += Math.abs(a.data[offset + channel] - b.data[offset + channel]);count++; }
        }
        return error / count;
      }, { before: before.toString('base64'), after: after.toString('base64'), rect, viewport });
      assert.ok(mae < 2, `captured image must remain aligned and sharp: density=${density}, zoom=${zoom}, mode=${mode}, MAE=${mae}`);
      assert.deepEqual(errors, []);
      console.log(`PASS: capture pixels at ${density}x density, ${Math.round(zoom * 100)}% zoom${mode ? ', ' + mode : ''}; MAE=${mae.toFixed(3)}/255`);
    } finally { await context.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve));await new Promise(resolve => foreign.close(resolve)); }
