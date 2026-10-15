export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const TAU = Math.PI * 2;
export const toColorRGB = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
