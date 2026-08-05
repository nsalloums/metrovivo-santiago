// Operación expresa (Ruta Roja/Verde): patrones de parada, headways por
// franja, transiciones de ventana y puntualidad.

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

/** Una estación que la Ruta Roja se salta en L4 (es decir, clasificada V). */
function verdeDeL4() {
  const L4 = data.lines.find((l) => l.id === 'L4');
  const id = Object.entries(L4.express.class).find(([, c]) => c === 'V')?.[0];
  expect(id, 'L4 debería tener al menos una estación verde').toBeTruthy();
  return id;
}

describe('headway efectivo por franja', () => {
  // El motor tiene dos regímenes (src/sim.js:219). Si el feed trae headways
  // POR VARIANTE (express.freq), cada variante despacha con sus propias
  // franjas y las de la línea sólo rigen fuera de la ventana expresa; si no,
  // todas las salidas siguen las franjas de la línea. El invariante común es
  // que dentro de una franja de una fuente dada, las salidas van al headway
  // declarado.
  const respeta = (times, bands, label) => {
    for (const [a, b, headway] of bands) {
      const inBand = times.filter((t) => t >= H(a) && t < H(b));
      for (let i = 1; i < inBand.length; i++) {
        expect(Math.abs(inBand[i] - inBand[i - 1] - headway), `${label} ${a}-${b}`)
          .toBeLessThanOrEqual(1);
      }
    }
  };

  it('las salidas consecutivas dentro de cada franja respetan el headway ±1 s', () => {
    for (const L of sim.lines) {
      const { times, pats } = sim._departures(L, 'wd');
      const vfreq = L.def.express?.freq;
      if (L.pat.R && vfreq) {
        // cada variante contra sus propias franjas
        for (const k of ['R', 'V']) {
          const own = times.filter((_, i) => pats[i] === k);
          respeta(own, vfreq[k]?.wd || [], `${L.def.id}/${k}`);
        }
        // las comunes sólo existen fuera de la ventana: se comprueba que
        // ninguna caiga dentro de ella
        const comunes = times.filter((_, i) => pats[i] === 'C');
        for (const t of comunes) {
          expect(sim.expressActive(L.def.id, t, 'wd'), `${L.def.id} común dentro de la ventana`).toBe(false);
        }
      } else {
        respeta(times, L.def.freq.wd, L.def.id);
      }
    }
  });
});

describe('patrones de parada', () => {
  it('L2, L4 y L5 tienen patrones R y V; el resto no', () => {
    for (const L of sim.lines) {
      const hasExp = ['L2', 'L4', 'L5'].includes(L.def.id);
      expect(Boolean(L.pat.R), L.def.id).toBe(hasExp);
      expect(Boolean(L.pat.V), L.def.id).toBe(hasExp);
    }
  });

  it('un tren Roja para en todas sus paradas + comunes y salta exactamente las verdes', () => {
    const L = sim.byId.get('L4');
    const { times, pats } = sim._departures(L, 'wd');
    const k = pats.findIndex((p, i) => p === 'R' && times[i] > H('07:00'));
    expect(k).toBeGreaterThan(-1);
    const key = `L4|0|${k}`;
    const P = L.pat.R;
    const dwells = new Set();
    for (let e = 0; e <= P.trip; e += 1) {
      sim.update(times[k] + e, 'wd');
      const t = sim.byKey.get(key);
      if (t && !t.moving && t.dwell) dwells.add(t.dwell);
    }
    const rList = data.lines.find((l) => l.id === 'L4').express.patterns.R;
    const cls = data.lines.find((l) => l.id === 'L4').express.class;
    // para en todas las paradas intermedias de su patrón (los terminales no
    // registran detención: el tren parte al spawnearse y despawnea al llegar;
    // la llegada puntual al terminal la cubre el test de puntualidad)
    for (const id of rList.slice(1, -1)) expect(dwells.has(id), `no paró en ${id}`).toBe(true);
    // …y en ninguna estación verde
    for (const [id, c] of Object.entries(cls)) {
      if (c === 'V') expect(dwells.has(id), `paró en la verde ${id}`).toBe(false);
    }
  });

  it('el tren Roja cruza las estaciones verdes en movimiento (velocidad > 0)', () => {
    const L = sim.byId.get('L4');
    const { times, pats } = sim._departures(L, 'wd');
    const k = pats.findIndex((p, i) => p === 'R' && times[i] > H('07:00'));
    const key = `L4|0|${k}`;
    const cls = data.lines.find((l) => l.id === 'L4').express.class;
    const S = L.def.stationS;
    let checked = 0;
    for (let e = 0; e <= L.pat.R.trip && checked < 5; e += 1) {
      sim.update(times[k] + e, 'wd');
      const t = sim.byKey.get(key);
      if (!t || !t.moving) continue;
      // ¿está cruzando ahora una estación verde? (a <30 m de su arco)
      const gi = L.def.stations.findIndex((id, i) => cls[id] === 'V' && Math.abs(S[i] - t.sGeo) < 30);
      if (gi >= 0) {
        expect(t.vKmh, `cruzando ${L.def.stations[gi]}`).toBeGreaterThan(40);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('tiempos de viaje y puntualidad', () => {
  it('el expreso extremo-a-extremo es más rápido que el común en L2/L4/L5', () => {
    for (const id of ['L2', 'L4', 'L5']) {
      const L = sim.byId.get(id);
      expect(L.pat.R.trip, `${id} R`).toBeLessThan(L.pat.C.trip);
      expect(L.pat.V.trip, `${id} V`).toBeLessThan(L.pat.C.trip);
    }
  });

  it('llegada puntual del expreso al terminal (±1 s)', () => {
    const L = sim.byId.get('L5');
    const { times, pats } = sim._departures(L, 'wd');
    const k = pats.findIndex((p, i) => p === 'V' && times[i] > H('06:30'));
    const key = `L5|0|${k}`;
    const P = L.pat.V;
    const term = L.def.stationS[L.def.stationS.length - 1];
    sim.update(times[k] + P.trip - 1, 'wd');
    expect(term - sim.byKey.get(key).sGeo).toBeLessThan(25); // llegando
    sim.update(times[k] + P.trip - 0.01, 'wd');
    expect(Math.abs(sim.byKey.get(key).sGeo - term)).toBeLessThan(0.01); // clavado
  });
});

describe('ventanas y transiciones', () => {
  it('fuera de punta (15:00) y en fin de semana: cero trenes con badge R/V', () => {
    sim.update(H('15:00'), 'wd');
    expect(sim.trains.filter((t) => t.pattern !== 'C').length).toBe(0);
    sim.update(H('08:00'), 'sa');
    expect(sim.trains.filter((t) => t.pattern !== 'C').length).toBe(0);
    sim.update(H('08:00'), 'su');
    expect(sim.trains.filter((t) => t.pattern !== 'C').length).toBe(0);
  });

  it('a las 08:00 hábil hay expresos R y V en cantidades parejas', () => {
    sim.update(H('08:00'), 'wd');
    const nR = sim.trains.filter((t) => t.pattern === 'R').length;
    const nV = sim.trains.filter((t) => t.pattern === 'V').length;
    expect(nR).toBeGreaterThan(0);
    expect(nV).toBeGreaterThan(0);
    expect(Math.abs(nR - nV)).toBeLessThanOrEqual(6); // alternancia × 3 líneas × 2 sentidos
  });

  it('al cerrar la ventana de la mañana los trenes en viaje completan su patrón', () => {
    const L = sim.byId.get('L4');
    // los bordes salen de los datos: el ejemplo cierra a las 09:00 y el feed
    // oficial abre la tarde a las 17:30, no a las 18:00
    const [, cierre] = L.def.express.windows.wd[0];
    const [tarde] = L.def.express.windows.wd[1];
    const { times, pats } = sim._departures(L, 'wd');
    // último expreso spawneado antes del cierre
    let k = -1;
    for (let i = 0; i < times.length; i++) {
      if (times[i] < H(cierre) && pats[i] !== 'C') k = i;
    }
    expect(k).toBeGreaterThan(-1);
    const key = `L4|0|${k}`, pat = pats[k];
    for (const s of [H(cierre) + 30, H(cierre) + 300]) {
      sim.update(s, 'wd');
      const t = sim.byKey.get(key);
      if (t) expect(t.pattern).toBe(pat); // sigue siendo expreso tras la ventana
    }
    // y entre ventanas todo lo que se genera es común
    const after = pats.filter((p, i) => times[i] >= H(cierre) && times[i] < H(tarde));
    expect(after.every((p) => p === 'C')).toBe(true);
  });

  it('expressActive refleja las ventanas 06-09 y 18-21 solo en L2/L4/L5 hábil', () => {
    expect(sim.expressActive('L4', H('08:00'), 'wd')).toBe(true);
    expect(sim.expressActive('L4', H('19:00'), 'wd')).toBe(true);
    expect(sim.expressActive('L4', H('12:00'), 'wd')).toBe(false);
    expect(sim.expressActive('L4', H('08:00'), 'sa')).toBe(false);
    expect(sim.expressActive('L1', H('08:00'), 'wd')).toBe(false);
  });
});

describe('panel LED', () => {
  it('en una estación verde durante la ventana solo se anuncian trenes que paran', () => {
    // la estación V se toma de los datos: qué estaciones son verdes depende
    // del feed (con el GTFS oficial francisco-bilbao ya no lo es)
    const arr = sim.arrivals(verdeDeL4(), H('08:00'), 'wd');
    const stopping = arr.filter((a) => !a.passing);
    expect(stopping.length).toBeGreaterThan(0);
    expect(stopping.every((a) => a.pattern !== 'R')).toBe(true);
    // y hay aviso de expreso que pasa sin detenerse
    expect(arr.some((a) => a.passing && a.pattern === 'R')).toBe(true);
  });

  it('fuera de la ventana los anuncios son todos comunes', () => {
    const arr = sim.arrivals(verdeDeL4(), H('12:00'), 'wd');
    expect(arr.length).toBeGreaterThan(0);
    expect(arr.every((a) => a.pattern === 'C' && !a.passing)).toBe(true);
  });
});
