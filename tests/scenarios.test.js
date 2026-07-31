// Escenarios de contingencia: integridad de los datos y la simulación
// obedeciéndolos sin teleports. El motor es puro, así que se testea sin DOM.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCENARIOS, SCENARIO_NAMES, scenarioFromQuery, alertsOf } from '../src/scenarios.js';
import { Simulation } from '../src/sim.js';
import { hhmmToSec } from '../src/time.js';

const H = hhmmToSec;
const sc = (name) => SCENARIOS[name];

let data;
beforeAll(() => {
  data = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8'));
});

describe('integridad de los escenarios', () => {
  it('cada línea referenciada existe en la red', () => {
    const ids = new Set(data.lines.map((l) => l.id));
    for (const name of SCENARIO_NAMES) {
      for (const lineId of Object.keys(sc(name).lines)) {
        expect(ids.has(lineId), `${name}: línea desconocida ${lineId}`).toBe(true);
      }
    }
  });

  // sin esto, un id mal escrito degrada en silencio: _targetOverlay hace
  // indexOf → -1 → lo filtra, y el escenario simplemente no hace nada
  it('cada estación cerrada pertenece a su línea', () => {
    for (const name of SCENARIO_NAMES) {
      for (const [lineId, l] of Object.entries(sc(name).lines)) {
        const stations = data.lines.find((x) => x.id === lineId).stations;
        for (const st of l.closedStations) {
          expect(stations.includes(st), `${name}/${lineId}: ${st} no está en la línea`).toBe(true);
        }
        for (const [a, b] of l.closedRanges) {
          expect(stations.includes(a), `${name}: ${a} no está en ${lineId}`).toBe(true);
          expect(stations.includes(b), `${name}: ${b} no está en ${lineId}`).toBe(true);
        }
      }
    }
  });

  it('los estados son válidos y los mensajes vienen sin HTML', () => {
    for (const name of SCENARIO_NAMES) {
      for (const [lineId, l] of Object.entries(sc(name).lines)) {
        expect(['normal', 'partial', 'suspended']).toContain(l.status);
        expect(l.message, `${name}/${lineId} sin mensaje`).toBeTruthy();
        expect(l.message, `${name}/${lineId} con HTML`).not.toMatch(/<[^>]+>/);
      }
    }
  });

  it('un tramo cerrado implica ≥2 estaciones contiguas cerradas', () => {
    for (const name of SCENARIO_NAMES) {
      for (const [lineId, l] of Object.entries(sc(name).lines)) {
        const stations = data.lines.find((x) => x.id === lineId).stations;
        for (const [a, b] of l.closedRanges) {
          const ia = stations.indexOf(a), ib = stations.indexOf(b);
          expect(ib).toBeGreaterThan(ia);
          for (let i = ia; i <= ib; i++) {
            expect(l.closedStations, `${name}: hueco en el tramo`).toContain(stations[i]);
          }
        }
      }
    }
  });
});

describe('selección por query string', () => {
  it('resuelve un escenario conocido', () => {
    const r = scenarioFromQuery('?estado=l1-suspendida');
    expect(r.name).toBe('l1-suspendida');
    expect(r.state.lines.L1.status).toBe('suspended');
  });

  it('sin parámetro o con nombre desconocido no hay escenario', () => {
    expect(scenarioFromQuery('')).toBeNull();
    expect(scenarioFromQuery('?t=8:30')).toBeNull();
    expect(scenarioFromQuery('?estado=no-existe')).toBeNull();
  });

  it('alertsOf lista solo las líneas afectadas', () => {
    expect(alertsOf(sc('normal'))).toEqual([]);
    const a = alertsOf(sc('estacion-cerrada'));
    expect(a).toHaveLength(1);
    expect(a[0].lineId).toBe('L2');
    expect(a[0].message).toContain('Los Héroes');
  });
});

describe('la simulación obedece al escenario', () => {
  it('suspensión preexistente (boot): cero trenes en la línea', () => {
    const sim = new Simulation(data);
    sim.applyEstado(sc('l1-suspendida'), 0);
    sim.update(H('12:00'), 'wd');
    expect(sim.trains.filter((t) => t.lineId === 'L1').length).toBe(0);
    expect(sim.trains.filter((t) => t.lineId === 'L2').length).toBeGreaterThan(0);
  });

  it('normal→suspendida→normal sin saltos ni teleports', () => {
    const sim = new Simulation(data);
    const T0 = H('12:10'), T1 = H('12:30');
    const MAX_STEP = 25; // m por segundo simulado (vmax ≈ 22 m/s)
    let prev = new Map();
    let frozeSomething = false;
    for (let s = H('12:05'); s <= H('12:50'); s++) {
      if (s === T0) sim.applyEstado(sc('l1-suspendida'), s);
      if (s === T1) sim.applyEstado(sc('normal'), s);
      sim.update(s, 'wd');
      for (const t of sim.trains) {
        if (t.lineId !== 'L1') continue;
        const p = prev.get(t.key);
        if (p !== undefined) {
          expect(Math.abs(t.sGeo - p), `salto de ${t.key} en s=${s}`).toBeLessThanOrEqual(MAX_STEP);
        }
        if (t.frozen) frozeSomething = true;
      }
      prev = new Map(sim.trains.filter((t) => t.lineId === 'L1').map((t) => [t.key, t.sGeo]));
    }
    expect(frozeSomething).toBe(true); // los en viaje frenaron en una estación
  });

  it('durante la suspensión no hay salidas nuevas; al reponer, reintroducción gradual', () => {
    const sim = new Simulation(data);
    const T0 = H('12:10'), T1 = H('12:30');
    sim.applyEstado(sc('l1-suspendida'), T0);
    sim.applyEstado(sc('normal'), T1);
    const L = sim.byId.get('L1');
    const { times } = sim._departures(L, 'wd');
    expect(times.some((t) => t >= T0 && t < T1)).toBe(false); // suprimidas
    const after = times.filter((t) => t >= T1 && t < T1 + 900);
    expect(after.length).toBeGreaterThan(0);
    const headway = 210; // valle
    for (let i = 1; i < after.length; i++) {
      expect(after[i] - after[i - 1]).toBeGreaterThanOrEqual(headway - 1); // no en masa
    }
    // los congelados se retiran poco después de la reposición
    sim.update(T1 + 60, 'wd');
    expect(sim.trains.filter((t) => t.lineId === 'L1' && t.frozen).length).toBe(0);
  });

  it('estación cerrada: los trenes nuevos la cruzan sin detenerse', () => {
    const sim = new Simulation(data);
    sim.applyEstado(sc('estacion-cerrada'), 0);
    const L = sim.byId.get('L2');
    const { times, pats } = sim._departures(L, 'wd');
    const k = times.findIndex((t) => t > H('10:00'));
    const P = sim._resolvePat(L, pats[k]);
    expect(P.stopSet.has(L.def.stations.indexOf('los-heroes'))).toBe(false);
    // barrido: nunca hay dwell en los-heroes
    const key = `L2|0|${k}`;
    for (let e = 0; e <= P.trip; e += 2) {
      sim.update(times[k] + e, 'wd');
      const t = sim.byKey.get(key);
      if (t && !t.moving) expect(t.dwell).not.toBe('los-heroes');
    }
    // y el LED de los-heroes no anuncia llegadas que paran, solo pasadas
    const arr = sim.arrivals('los-heroes', H('12:00'), 'wd');
    expect(arr.filter((a) => a.lineId === 'L2' && !a.passing).length).toBe(0);
  });

  it('cierre parcial: turnback en la frontera, trenes solo en tramos abiertos', () => {
    const sim = new Simulation(data);
    sim.applyEstado(sc('cierre-parcial'), 0);
    sim.update(H('12:00'), 'wd');
    const L = sim.byId.get('L5');
    const S = L.def.stationS;
    const border = S[L.def.stations.indexOf('las-parcelas')]; // primera abierta
    const l5 = sim.trains.filter((t) => t.lineId === 'L5');
    expect(l5.length).toBeGreaterThan(0);
    for (const t of l5) {
      expect(t.sGeo, `${t.key} dentro del tramo cerrado`).toBeGreaterThanOrEqual(border - 1);
    }
    // ambos sentidos operan en el tramo abierto (retorno en la frontera)
    expect(l5.some((t) => t.dir === 0)).toBe(true);
    expect(l5.some((t) => t.dir === 1)).toBe(true);
  });

  it('sin escenario la red opera normal en todas las líneas', () => {
    const sim = new Simulation(data);
    sim.update(H('12:00'), 'wd');
    for (const line of data.lines) {
      expect(sim.trains.some((t) => t.lineId === line.id), `${line.id} sin trenes`).toBe(true);
    }
  });
});
