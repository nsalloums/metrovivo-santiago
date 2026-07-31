// Respeto de prefers-reduced-motion: sin estelas y tweens de cámara cortos.

export const REDUCED_MOTION =
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Duración de tween, acortada drásticamente si el usuario pide menos movimiento. */
export const dur = (s) => (REDUCED_MOTION ? Math.min(0.3, s * 0.2) : s);
