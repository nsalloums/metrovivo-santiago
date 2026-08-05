// Feriados y vigencia del feed: el tipo de día NO es el día de la semana.
//
// El caso que da nombre a todo esto: el 18 de septiembre de 2026 cae VIERNES
// y la red opera con horario de domingo. Antes de calendar_dates.txt, ocho
// días al año la simulación dibujaba frecuencias de día hábil.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { santiagoNow } from '../src/time.js';

const data = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8'));
const cal = data.calendar;
const H = cal.holidays;

// mediodía en Santiago de una fecha AAAAMMDD (UTC-3/-4 según la época)
const alMediodia = (ymd) => new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T15:00:00Z`);

describe('calendario del feed', () => {
  it('network.json trae el calendario con feriados y vigencia', () => {
    expect(cal).toBeTruthy();
    expect(cal.version).toBe('V166.20260704');
    expect(cal.start).toBe('20260704');
    expect(cal.end).toBe('20261231');
    expect(Object.keys(H).length).toBe(8);
  });

  it('todos los feriados del feed operan con horario de domingo', () => {
    for (const [fecha, tipo] of Object.entries(H)) {
      expect(tipo, fecha).toBe('su');
      expect(fecha, 'dentro de la vigencia del feed').toMatch(/^2026(0[7-9]|1[0-2])\d{2}$/);
    }
  });

  it('el 18 de septiembre cae viernes y aun así es domingo de servicio', () => {
    const d = alMediodia('20260918');
    expect(d.getUTCDay()).toBe(5); // viernes
    expect(santiagoNow(d, null).day, 'sin tabla de feriados se equivoca').toBe('wd');
    const con = santiagoNow(d, H);
    expect(con.day).toBe('su');
    expect(con.feriado).toBe('su');
    expect(con.semanal).toBe('wd'); // se conserva lo que habría sido
    expect(con.date).toBe('20260918');
  });

  it('un día normal no se ve afectado por la tabla', () => {
    const d = alMediodia('20260917'); // jueves cualquiera
    expect(santiagoNow(d, H).day).toBe('wd');
    expect(santiagoNow(d, H).feriado).toBeNull();
    const sab = alMediodia('20260919'); // sábado, pero feriado → domingo
    expect(santiagoNow(sab, null).day).toBe('sa');
    expect(santiagoNow(sab, H).day).toBe('su');
  });

  it('los 8 feriados de 2026 son los que el feed declara', () => {
    expect(Object.keys(H).sort()).toEqual([
      '20260716', // Virgen del Carmen
      '20260815', // Asunción
      '20260918', // Independencia
      '20260919', // Glorias del Ejército
      '20261012', // Encuentro de Dos Mundos
      '20261031', // Iglesias Evangélicas
      '20261208', // Inmaculada Concepción
      '20261225', // Navidad
    ]);
  });
});

describe('interior de las estaciones (pathways + levels)', () => {
  const st = data.stations;
  const conComb = Object.values(st).filter((s) => s.in?.comb);

  it('las 17 estaciones de combinación tienen tiempo medido', () => {
    const multi = Object.entries(st).filter(([, s]) => s.lines.length > 1);
    expect(multi.length).toBe(17);
    for (const [id, s] of multi) expect(s.in?.comb, id).toBeTruthy();
    expect(conComb.length).toBe(17);
  });

  it('cada estación declara la profundidad de andén de sus líneas', () => {
    for (const [id, s] of Object.entries(st)) {
      expect(s.in, id).toBeTruthy();
      for (const l of s.lines) {
        expect(s.in.prof[l], `${id}/${l}`).toBeTypeOf('number');
        // el rango cubre las dos realidades de la red: −5 (U. de Chile L3) y
        // +3 (el viaducto de L5 al poniente). Metro de Santiago no es todo
        // subterráneo, y el feed lo dice.
        expect(s.in.prof[l], `${id}/${l}`).toBeGreaterThanOrEqual(-6);
        expect(s.in.prof[l], `${id}/${l}`).toBeLessThanOrEqual(4);
      }
      expect(s.in.niveles).toBeGreaterThanOrEqual(1);
      expect(s.in.andenes).toBeGreaterThanOrEqual(1);
      expect(s.in.accesosSF).toBeLessThanOrEqual(s.in.accesos);
      expect(s.in.sinEscalones).toBeLessThanOrEqual(s.in.andenes);
    }
  });

  it('los tiempos de combinación son de andén a andén y creíbles', () => {
    for (const s of conComb) {
      for (const [par, c] of Object.entries(s.in.comb)) {
        const [a, b] = par.split('|');
        expect(s.lines, par).toContain(a);
        expect(s.lines, par).toContain(b);
        expect(c.s).toBeGreaterThan(10);    // ninguna combinación es instantánea
        expect(c.s).toBeLessThan(400);      // ni un viaje aparte
        // la ruta sin escalones nunca puede ser MÁS RÁPIDA que la más corta
        if (c.sf != null) expect(c.sf).toBeGreaterThanOrEqual(c.s);
      }
    }
  });

  it('distingue estaciones subterráneas, a nivel y en viaducto', () => {
    const niveles = Object.values(st).flatMap((s) => Object.values(s.in.prof));
    expect(niveles.filter((n) => n < 0).length, 'subterráneas').toBeGreaterThan(100);
    expect(niveles.filter((n) => n === 0).length, 'a nivel de calle').toBeGreaterThan(0);
    expect(niveles.filter((n) => n > 0).length, 'elevadas').toBeGreaterThan(10);
    expect(st['u-de-chile'].in.prof.L3, 'la más profunda').toBe(-5);
    expect(st['macul'].in.prof.L4, 'viaducto de L4').toBeGreaterThan(0);
  });

  it('Los Héroes es la combinación más rápida y Plaza de Armas la más lenta', () => {
    const todas = conComb.flatMap((s) => Object.values(s.in.comb).map((c) => c.s));
    expect(st['los-heroes'].in.comb['L1|L2'].s).toBe(Math.min(...todas));
    expect(st['plaza-de-armas'].in.comb['L3|L5'].s).toBe(Math.max(...todas));
    // y Plaza de Armas lo es porque L3 va cuatro niveles bajo la calle
    expect(st['plaza-de-armas'].in.prof.L3).toBe(-4);
  });
});
