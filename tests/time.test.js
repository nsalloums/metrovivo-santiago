// La hora debe derivarse SIEMPRE vía Intl con zona America/Santiago.
// Chile alterna UTC-3 (verano austral) / UTC-4 (invierno): un offset fijo
// daría una hora incorrecta la mitad del año.

import { describe, it, expect } from 'vitest';
import { santiagoNow, hhmmToSec, secToHHMM } from '../src/time.js';

describe('hora en America/Santiago', () => {
  it('enero (verano austral): UTC-3', () => {
    // 15-ene-2026 15:00 UTC → 12:00 en Santiago
    const { sec, day } = santiagoNow(new Date('2026-01-15T15:00:00Z'));
    expect(sec).toBe(12 * 3600);
    expect(day).toBe('wd'); // jueves
  });

  it('julio (invierno austral): UTC-4', () => {
    // 15-jul-2026 16:00 UTC → 12:00 en Santiago
    const { sec, day } = santiagoNow(new Date('2026-07-15T16:00:00Z'));
    expect(sec).toBe(12 * 3600);
    expect(day).toBe('wd'); // miércoles
  });

  it('un mismo instante UTC cae en horas distintas según la estación', () => {
    const ene = santiagoNow(new Date('2026-01-15T15:00:00Z')).sec;
    const jul = santiagoNow(new Date('2026-07-15T15:00:00Z')).sec;
    expect(ene - jul).toBe(3600); // una hora de diferencia (DST)
  });

  it('clasifica sábado y domingo', () => {
    expect(santiagoNow(new Date('2026-07-04T16:00:00Z')).day).toBe('sa');
    expect(santiagoNow(new Date('2026-07-05T16:00:00Z')).day).toBe('su');
  });

  it('cruce de medianoche: 03:00 UTC de julio es 23:00 del día anterior', () => {
    const { sec, day } = santiagoNow(new Date('2026-07-16T03:00:00Z'));
    expect(sec).toBe(23 * 3600);
    expect(day).toBe('wd'); // aún miércoles 15 en Santiago
  });

  it('helpers hh:mm', () => {
    expect(hhmmToSec('06:00')).toBe(21600);
    expect(secToHHMM(21600)).toBe('06:00');
    expect(secToHHMM(hhmmToSec('23:59'))).toBe('23:59');
  });
});
