import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { closedUI } from './closed-shadow.mjs';

const browser = await chromium.launch({ args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));page.on('dialog', dialog => { errors.push(dialog.message());void dialog.dismiss(); });
  await page.goto(new URL('../dev/index.html', import.meta.url).href);
  const host = page.locator('#nurupuru-anywhere');
  await host.waitFor({ state: 'attached' });
  const closed = await closedUI(page), { control, ui } = closed, panel = ui('panel');
  async function state(name, expected = name) {
    await page.locator('.states [data-state=' + name + ']').click();
    await host.waitFor({ state: 'attached' });await closed.refresh();
    await closed.waitFor((root, expected) => root.getElementById('panel').dataset.state === expected, expected);
    assert.equal(await panel.getAttribute('data-state'), expected);
  }
  await state('idle');assert.equal(await control('#selectLabel').textContent(), '画像を選ぶ');
  assert.equal(await control('#stateLabel,#targetName').count(), 0, 'image selection status is integrated into the selection button');
  await state('selecting');assert.equal(await control('#selectLabel').textContent(), '画像を選択中');
  await page.screenshot({ path: fileURLToPath(new URL('../test-results/preview-selecting.png', import.meta.url)) });
  await state('brush');assert.equal(await control('#brush').isVisible(), true);
  await control('#material summary').click();
  await page.screenshot({ path: fileURLToPath(new URL('../test-results/preview-brush.png', import.meta.url)) });
  await state('erase');assert.equal(await control('#strengthRow').isVisible(), false);
  await state('grab');assert.equal(await control('#grab').isVisible(), true);assert.equal(await control('#brush').isVisible(), false);
  await page.screenshot({ path: fileURLToPath(new URL('../test-results/preview-grab.png', import.meta.url)) });
  await state('off');assert.equal(await control('[data-tool=brush]').isDisabled(), true);
  await state('folded', 'grab');assert.equal(await control('#detail').isVisible(), false);assert.equal(await control('#release').isVisible(), true);
  await page.screenshot({ path: fileURLToPath(new URL('../test-results/preview-folded.png', import.meta.url)) });
  await control('#release').click();assert.equal(await panel.getAttribute('data-state'), 'idle');
  await state('brush');
  await page.setViewportSize({ width: 360, height: 800 });
  const bounds = await panel.boundingBox();assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360 && bounds.y >= 0);
  assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'panel does not overflow horizontally');
  await control('#close').click();await state('brush');assert.equal(await host.count(), 1, 'preview can reopen the real UI after closing');
  assert.deepEqual(errors, []);
  console.log('PASS: direct-file HTML preview uses the actual extension UI; all states, release/reopen and narrow layout');
} finally { await browser.close(); }
