import { t } from './i18n.js';
const LIMIT = 1600;
function surface(width, height) {
  const c = document.createElement('canvas'), scale = Math.min(devicePixelRatio || 1, 2, LIMIT / Math.max(width, height));
  c.width = Math.max(2, Math.round(width * scale));c.height = Math.max(2, Math.round(height * scale));
  return c;
}
export function imageRect(image) {
  const r = image.getBoundingClientRect(), s = getComputedStyle(image);
  const value = name => parseFloat(s[name]) || 0;
  const x = value('borderLeftWidth') + value('paddingLeft'), y = value('borderTopWidth') + value('paddingTop');
  return { left: r.left + x, top: r.top + y, width: r.width - x - value('borderRightWidth') - value('paddingRight'), height: r.height - y - value('borderBottomWidth') - value('paddingBottom') };
}
function position(value, free) {
  if (value.endsWith('%')) return free * parseFloat(value) / 100;
  if (value === 'left' || value === 'top') return 0;
  if (value === 'right' || value === 'bottom') return free;
  if (value === 'center') return free / 2;
  return parseFloat(value) || 0;
}
function captureViewport() {
  const v = visualViewport;
  return { width: v?.width || innerWidth, height: v?.height || innerHeight, left: v?.offsetLeft || 0, top: v?.offsetTop || 0, ratio: (devicePixelRatio || 1) * (v?.scale || 1) };
}
export async function readSource(image, host) {
  if (!image.complete) await image.decode();
  const rect = imageRect(image), style = getComputedStyle(image);
  const sourceUrl = image.currentSrc || image.src;
  if (rect.width < 8 || rect.height < 8 || !image.naturalWidth) throw Error(t('visibleImage'));
  const c = surface(rect.width, rect.height), g = c.getContext('2d');
  try {
    const iw = image.naturalWidth, ih = image.naturalHeight;
    let w = rect.width, h = rect.height;
    if (style.objectFit !== 'fill') {
      let scale = style.objectFit === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
      if (style.objectFit === 'none') scale = 1;
      if (style.objectFit === 'scale-down') scale = Math.min(1, scale);
      w = iw * scale;h = ih * scale;
    }
    const parts = style.objectPosition.split(' ');
    const x = position(parts[0], rect.width - w), y = position(parts[1] || '50%', rect.height - h);
    g.drawImage(image, x * c.width / rect.width, y * c.height / rect.height, w * c.width / rect.width, h * c.height / rect.height);
    g.getImageData(0, 0, 1, 1);
    return { image: c, rect, capture: false, slice: { x: 0, y: 0, w: 1, h: 1 } };
  } catch (error) {
    if (error.name !== 'SecurityError') throw error;
  }
  // Cross-origin pixels may be protected. Capture the displayed appearance
  // using activeTab, without re-requesting the original image URL.
  const viewport = captureViewport();
  const left = Math.max(viewport.left, rect.left), top = Math.max(viewport.top, rect.top);
  const width = Math.min(viewport.left + viewport.width, rect.left + rect.width) - left, height = Math.min(viewport.top + viewport.height, rect.top + rect.height) - top;
  if (width < 8 || height < 8) throw Error(t('bringIntoView'));
  let reply;
  host.style.setProperty('visibility', 'hidden', 'important');
  try {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    reply = await chrome.runtime.sendMessage({ type: 'nurupuru:capture' });
  } finally { host.style.removeProperty('visibility'); }
  if (!reply?.ok) throw Error(reply?.error || t('captureFailed'));
  const bitmap = await createImageBitmap(await (await fetch(reply.dataUrl)).blob());
  try {
    const after = imageRect(image);
    const current = captureViewport();
    if (Object.keys(viewport).some(key => current[key] !== viewport[key]) || (image.currentSrc || image.src) !== sourceUrl || ['left', 'top', 'width', 'height'].some(key => Math.abs(after[key] - rect[key]) > 1)) throw Error(t('captureChanged'));
    // Use the display's pixel ratio, not bitmap.width / innerWidth: the latter
    // mixes rounded CSS dimensions and scrollbar pixels at fractional zoom.
    const scale = viewport.ratio;
    const x = Math.max(0, Math.floor((left - viewport.left) * scale)), y = Math.max(0, Math.floor((top - viewport.top) * scale));
    const right = Math.min(bitmap.width, Math.ceil((left + width - viewport.left) * scale)), bottom = Math.min(bitmap.height, Math.ceil((top + height - viewport.top) * scale));
    // Copy whole captured pixels once. Preserve their bounds when positioning the
    // mesh rather than resampling the screenshot into the image's fractional box.
    const crop = document.createElement('canvas');crop.width = right - x;crop.height = bottom - y;
    crop.getContext('2d').drawImage(bitmap, x, y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return { image: crop, rect, capture: true, slice: { x: (viewport.left + x / scale - rect.left) / rect.width, y: (viewport.top + y / scale - rect.top) / rect.height, w: crop.width / scale / rect.width, h: crop.height / scale / rect.height } };
  } finally { bitmap.close(); }
}
