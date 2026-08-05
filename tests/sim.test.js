// El motor es una función pura f(hora, tipo de día) → posiciones,
// así que se testea sin renderer ni DOM.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/sim.js';
import { hhmmToSec } from '../src/time.js';

const H = hhmmToSec;
let data, sim;

beforeAll(() => {
  data = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8'));
  sim = new Simulation(data);
});

// snapshot profundo: sim.update reutiliza un pool, hay que copiar para comparar
const snap = (trains) => trains.map((t) => ({ ...t }));

// La apertura sale de los datos, no de una constante: el dataset de ejemplo
// abre a las 06:00 y el GTFS oficial a las 05:00, y el invariante que importa
// —cerrado antes de abrir, con trenes justo después— vale para ambos.
const opens = (day) => Math.min(...data.lines.map((l) => H(l.service[day][0])));

describe('horario de servicio', () => {
  it('un minuto antes de abrir el metro está cerrado y no hay trenes', () => {
    const t = opens('wd') - 60;
    expect(sim.serviceOpen(t, 'wd')).toBe(false);
    expect(sim.update(t, 'wd').length).toBe(0);
  });

  it('a la hora de apertura salen los primeros trenes', () => {
    expect(sim.serviceOpen(opens('wd'), 'wd')).toBe(true);
    const trains = sim.update(opens('wd') + 30, 'wd');
    expect(trains.length).toBeGreaterThan(0);
  });

  it('a las 03:00 no hay servicio ni trenes rezagados', () => {
    expect(sim.serviceOpen(H('03:00'), 'wd')).toBe(false);
    expect(sim.update(H('03:00'), 'wd').length).toBe(0);
  });

  it('el domingo abre más tarde que en día hábil, y no antes de su hora', () => {
    expect(opens('su')).toBeGreaterThan(opens('wd'));
    expect(sim.update(opens('su') - 60, 'su').length).toBe(0);
    expect(sim.update(opens('su') + 900, 'su').length).toBeGreaterThan(0);
  });
});

describe('flota activa coherente con el headway', () => {
  it('a las 12:00 hábil todas las líneas tienen trenes', () => {
    const trains = snap(sim.update(H('12:00'), 'wd'));
    for (const line of data.lines) {
      const count = trains.filter((t) => t.lineId === line.id).length;
      expect(count, `${line.id} sin trenes`).toBeGreaterThan(0);

      // por sentido ≈ tiempo de viaje / headway vigente (±2 por bordes de franja)
      const headway = line.freq.wd.find(([a, b]) => H('12:00') >= H(a) && H('12:00') < H(b))[2];
      const L = sim.byId.get(line.id);
      const expected = Math.ceil(L.trip / headway);
      const perDir = trains.filter((t) => t.lineId === line.id && t.dir === 0).length;
      expect(Math.abs(perDir - expected), `${line.id}: ${perDir} vs esperado ${expected}`)
        .toBeLessThanOrEqual(2);
    }
  });

  it('en punta hay más trenes que en la noche', () => {
    const punta = sim.update(H('08:00'), 'wd').length;
    const noche = sim.update(H('22:30'), 'wd').length;
    expect(punta).toBeGreaterThan(noche);
  });
});

describe('cinemática de un tren', () => {
  it('avanza monótonamente y se detiene ~20 s en cada estación', () => {
    const L = sim.byId.get('L1');
    const dep0 = sim._departures(L, 'wd').times[3]; // una salida de la mañana
    const key = 'L1|0|3';
    let prev = -1;
    const dwells = new Map(); // estación → segundos detenido
    for (let e = 0; e <= L.trip; e += 1) {
      const t = sim.update(dep0 + e, 'wd') && sim.byKey.get(key);
      if (!t) continue;
      expect(t.sGeo, `retrocedió en e=${e}`).toBeGreaterThanOrEqual(prev);
      if (!t.moving && t.dwell) dwells.set(t.dwell, (dwells.get(t.dwell) || 0) + 1);
      prev = t.sGeo;
    }
    // todas las estaciones intermedias registran una detención de ~20 s
    const inter = L.def.stations.slice(1, -1);
    for (const st of inter) {
      expect(dwells.get(st), `sin detención en ${st}`).toBeGreaterThanOrEqual(18);
      expect(dwells.get(st)).toBeLessThanOrEqual(22);
    }
  });

  it('las llegadas del panel coinciden con la posición del tren', () => {
    // un tren detenido en una estación debe aparecer "EN ANDÉN" en esa estación
    sim.update(H('12:00'), 'wd');
    const dwelling = sim.trains.find((t) => !t.moving && t.dwell && t.next);
    expect(dwelling).toBeDefined();
    const arr = sim.arrivals(dwelling.dwell, H('12:00'), 'wd');
    expect(arr.some((a) => a.lineId === dwelling.lineId && a.atPlatform)).toBe(true);
  });
});

describe('cambio de franja horaria', () => {
  it('no teletransporta trenes al cruzar las 09:00', () => {
    // velocidad máxima física: 1.5 × crucero ≈ 21 m/s
    const MAX_STEP = 25; // m por segundo simulado
    let before = new Map();
    for (let s = H('08:59'); s <= H('09:02'); s++) {
      sim.update(s, 'wd');
      for (const t of sim.trains) {
        const prev = before.get(t.key);
        if (prev !== undefined) {
          expect(Math.abs(t.sGeo - prev), `salto de ${t.key} en s=${s}`)
            .toBeLessThanOrEqual(MAX_STEP);
        }
      }
      before = new Map(sim.trains.map((t) => [t.key, t.sGeo]));
    }
  });

  it('las salidas de un día son deterministas y crecientes', () => {
    const L = sim.byId.get('L5');
    const { times } = sim._departures(L, 'wd');
    expect(times.length).toBeGreaterThan(100);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
    // la primera salida es el inicio de la primera franja de la línea
    expect(times[0]).toBe(H(L.def.freq.wd[0][0]));
  });
});
