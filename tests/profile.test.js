// Validación del perfil de velocidad trapezoidal: integral = largo del
// tramo, llegada puntual, clamp de 80 km/h y media igual a la del horario.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Simulation, trapezoidProfile, profileDist, profileVel } from '../src/sim.js';
import { hhmmToSec } from '../src/time.js';

const VMAX = 80 / 3.6;
let data, sim;

beforeAll(() => {
  data = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8'));
  sim = new Simulation(data);
});

describe('perfil trapezoidal por tramo (todas las líneas)', () => {
  it('cubre exactamente el largo del tramo en el tiempo programado', () => {
    for (const L of sim.lines) {
      const S = L.def.stationS;
      for (let i = 0; i < L.prof.length; i++) {
        const D = S[i + 1] - S[i];
        const T = L.sched[0].arr[i + 1] - L.sched[0].dep[i];
        const p = L.prof[i];
        // integral numérica de la velocidad = distancia
        let dist = 0;
        const dt = T / 2000;
        for (let k = 0; k < 2000; k++) dist += profileVel(p, (k + 0.5) * dt, T) * dt;
        expect(Math.abs(dist - D), `${L.def.id} tramo ${i}: integral`).toBeLessThan(D * 0.005);
        // forma cerrada: llegada puntual exacta
        expect(Math.abs(profileDist(p, T, T, D) - D)).toBeLessThan(1e-6);
        // media del tramo = la del horario (±1%)
        const media = dist / T;
        expect(Math.abs(media - D / T), `${L.def.id} tramo ${i}: media`).toBeLessThan((D / T) * 0.01);
      }
    }
  });

  it('la velocidad nunca supera los 80 km/h', () => {
    for (const L of sim.lines) {
      const S = L.def.stationS;
      for (let i = 0; i < L.prof.length; i++) {
        const T = L.sched[0].arr[i + 1] - L.sched[0].dep[i];
        expect(L.prof[i].v, `${L.def.id} tramo ${i}`).toBeLessThanOrEqual(VMAX + 1e-9);
        for (let k = 0; k <= 50; k++) {
          expect(profileVel(L.prof[i], (T * k) / 50, T)).toBeLessThanOrEqual(VMAX + 1e-9);
        }
      }
    }
  });

  it('crucero de L1 en rango físico: 30-80 km/h, y ≥50 en tramos largos', () => {
    const L = sim.byId.get('L1');
    const S = L.def.stationS;
    L.prof.forEach((p, i) => {
      const kmh = p.v * 3.6;
      // los tramos céntricos cortos (~340 m en 45 s) cruceran bajo; es correcto
      expect(kmh).toBeGreaterThan(30);
      expect(kmh).toBeLessThanOrEqual(80);
      if (S[i + 1] - S[i] > 600) expect(kmh, `tramo largo ${i}`).toBeGreaterThan(50);
    });
  });

  it('el perfil es continuo (sin saltos de posición) y monótono', () => {
    const p = trapezoidProfile(800, 60);
    let prev = 0;
    for (let k = 0; k <= 600; k++) {
      const s = profileDist(p, (60 * k) / 600, 60, 800);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(s - prev).toBeLessThan(VMAX * 0.1 + 0.01); // paso ≤ vmax·dt
      prev = s;
    }
  });
});

describe('llegada puntual en la simulación', () => {
  it('el tren queda clavado en la estación al cumplirse el horario (±1 s)', () => {
    const L = sim.byId.get('L1');
    const dep0 = sim._departures(L, 'wd').times[5];
    const { arr } = L.sched[0];
    const S = L.def.stationS;
    for (let j = 1; j < 6; j++) {
      // 1 s después del arribo programado debe estar detenido en la estación j
      sim.update(dep0 + arr[j] + 1, 'wd');
      const t = sim.byKey.get('L1|0|5');
      expect(t.moving).toBe(false);
      expect(Math.abs(t.sGeo - S[j]), `estación ${j}`).toBeLessThan(0.01);
      // 1 s antes del arribo aún viene llegando, a menos de vmax·1s de distancia
      sim.update(dep0 + arr[j] - 1, 'wd');
      const t2 = sim.byKey.get('L1|0|5');
      expect(S[j] - t2.sGeo).toBeGreaterThan(0);
      expect(S[j] - t2.sGeo).toBeLessThan(VMAX + 1);
    }
  });

  it('el velocímetro marca 0 en estación y >0 en ruta', () => {
    const L = sim.byId.get('L1');
    const dep0 = sim._departures(L, 'wd').times[5];
    const { arr, dep } = L.sched[0];
    sim.update(dep0 + arr[2] + 5, 'wd'); // dwell en estación 2
    expect(sim.byKey.get('L1|0|5').vKmh).toBe(0);
    sim.update(dep0 + (dep[2] + arr[3]) / 2, 'wd'); // mitad del tramo
    const v = sim.byKey.get('L1|0|5').vKmh;
    expect(v).toBeGreaterThan(40);
    expect(v).toBeLessThanOrEqual(80);
  });
});
