import { t } from './i18n.js';
export async function activate(tab) {
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    await chrome.action.setTitle({ tabId: tab.id, title: t('actionTitle') });
  } catch (error) {
    console.warn('Nurupuru Anywhere:', error.message);
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: t('unsupportedPage') });
  }
}
chrome.action.onClicked.addListener(activate);

let nextCapture = 0;
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'nurupuru:capture' || !sender.tab?.id) return false;
  const tabId = sender.tab.id;
  (async () => {
    // captureVisibleTab is limited to two calls per second.
    const now = Date.now(), delay = Math.max(0, nextCapture - now);
    nextCapture = now + delay + 600;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || !(await chrome.windows.get(tab.windowId)).focused) throw Error(t('keepTabVisible'));
    return { ok: true, dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) };
  })().then(reply, error => reply({ ok: false, error: error.message }));
  return true;
});
