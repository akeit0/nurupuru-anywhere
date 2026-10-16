import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { closedUI } from './closed-shadow.mjs';

const browser = await chromium.launch({ args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  for (const locale of ['ja-JP', 'en-US', 'fr-FR']) {
    const english = !locale.startsWith('ja');
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale }), errors = [];
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
    assert.equal(await panel.getAttribute('lang'), english ? 'en' : 'ja');
    await state('idle');assert.equal(await control('#selectLabel').textContent(), english ? 'Select image' : '画像を選ぶ');
    assert.equal(await control('#stateLabel,#targetName').count(), 0, 'image selection status is integrated into the selection button');
    await state('selecting');assert.equal(await control('#selectLabel').textContent(), english ? 'Selecting image' : '画像を選択中');
    await page.screenshot({ path: fileURLToPath(new URL('../test-results/preview-selecting.png', import.meta.url)) });
    await state('brush');assert.equal(await control('#brush').isVisible(), true);
    await control('#material').evaluate(el => el.open = true);
    await page.screenshot({ path: fileURLToPath(new URL('../test-results/preview-brush.png', import.meta.url)) });
    await state('erase');assert.equal(await control('#strengthRow').isVisible(), false);
    await state('grab');assert.equal(await control('#grab').isVisible(), true);assert.equal(await control('#brush').isVisible(), false);
    assert.equal(await ui('grabRadius').isVisible(), true);
    assert.equal(await ui('grabRadius').evaluate(el => el.closest('label').firstChild.textContent.trim()), english ? 'Grab radius' : 'つかむ範囲');
    await page.screenshot({ path: fileURLToPath(new URL('../test-results/preview-grab.png', import.meta.url)) });
    await state('off');assert.equal(await control('[data-tool=brush]').isDisabled(), true);
    await state('folded', 'grab');assert.equal(await control('#detail').isVisible(), false);assert.equal(await control('#release').isVisible(), true);
    await page.screenshot({ path: fileURLToPath(new URL('../test-results/preview-folded.png', import.meta.url)) });
    await control('#release').click();assert.equal(await panel.getAttribute('data-state'), 'idle');
    await state('brush');
    await page.setViewportSize({ width: 360, height: 800 });
    const bounds = await panel.boundingBox();assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360 && bounds.y >= 0);
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'panel does not overflow horizontally');
    await control('#material').evaluate(el => el.open = true);
    assert.equal(await control('#material summary').textContent(), english ? 'Material' : '材質');
    await page.screenshot({ path: fileURLToPath(new URL('../test-results/preview-' + locale + '-narrow.png', import.meta.url)) });
    assert.equal(await control('#size').evaluate(el => el.getBoundingClientRect().width >= 80), true, 'translated labels leave enough room for sliders');
    await state('grab');
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'translated grab controls fit the narrow panel');
    assert.ok(await ui('grabRadius').evaluate(el => el.getBoundingClientRect().width >= 80), 'grab radius slider remains usable in the narrow layout');
    await page.screenshot({ path: fileURLToPath(new URL('../test-results/preview-' + locale + '-grab-radius.png', import.meta.url)) });
    if (english) {
      const labels = await panel.evaluate(el => { const copy = el.cloneNode(true);copy.querySelector('#selectHint').remove();return copy.textContent; });
      assert.doesNotMatch(labels, /[ぁ-んァ-ヶ一-龠]/, 'English controls contain no untranslated Japanese; image alt text is kept as supplied by the page');
    }
    await control('#close').click();await state('brush');assert.equal(await host.count(), 1, 'preview can reopen the real UI after closing');
    await control('#release').click();
    await control('#select').click();
    await page.locator('#sample').evaluate(el => el.style.width = '1px');
    await page.locator('#sample').evaluate(el => el.click());
    await closed.waitFor(root => root.getElementById('status').textContent.includes('visible image') || root.getElementById('status').textContent.includes('表示されている画像'));
    assert.equal(await control('#status').textContent(), english ? 'Select a visible image.' : '表示されている画像を選んでください。');
    assert.deepEqual(errors, []);
    await page.close();
    console.log('PASS (' + locale + '): direct-file preview, automatic language, all states, release/reopen, translated error and narrow layout');
  }
} finally { await browser.close(); }
