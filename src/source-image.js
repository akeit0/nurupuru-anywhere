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
export async function readSource(image, host) {
  if (!image.complete) await image.decode();
  const rect = imageRect(image), style = getComputedStyle(image);
  const sourceUrl = image.currentSrc || image.src;
  if (rect.width < 8 || rect.height < 8 || !image.naturalWidth) throw Error('表示されている画像を選んでください。');
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
  const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  const width = Math.min(innerWidth, rect.left + rect.width) - left, height = Math.min(innerHeight, rect.top + rect.height) - top;
  if (width < 8 || height < 8) throw Error('画像を画面内に表示してから選んでください。');
  let reply;
  const viewport = { width: innerWidth, height: innerHeight };
  host.style.setProperty('visibility', 'hidden', 'important');
  try {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    reply = await chrome.runtime.sendMessage({ type: 'nurupuru:capture' });
  } finally { host.style.removeProperty('visibility'); }
  if (!reply?.ok) throw Error(reply?.error || '画像を取得できませんでした。');
  const bitmap = await createImageBitmap(await (await fetch(reply.dataUrl)).blob());
  try {
    const after = imageRect(image);
    if (innerWidth !== viewport.width || innerHeight !== viewport.height || (image.currentSrc || image.src) !== sourceUrl || ['left', 'top', 'width', 'height'].some(key => Math.abs(after[key] - rect[key]) > 1)) throw Error('取得中に画像や画面サイズが変わりました。もう一度選んでください。');
    const crop = surface(width, height), ctx = crop.getContext('2d');
    ctx.drawImage(bitmap, left * bitmap.width / viewport.width, top * bitmap.height / viewport.height, width * bitmap.width / viewport.width, height * bitmap.height / viewport.height, 0, 0, crop.width, crop.height);
    return { image: crop, rect, capture: true, slice: { x: (left - rect.left) / rect.width, y: (top - rect.top) / rect.height, w: width / rect.width, h: height / rect.height } };
  } finally { bitmap.close(); }
}
