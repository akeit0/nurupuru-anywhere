import { scalar } from './wasm/physics-binary.js';

export const binaries = { 'wasm-scalar': scalar };
export const PHYSICS_BACKENDS = ['wasm-scalar', 'js'];
export const DEFAULT_BACKEND = 'wasm-scalar';
