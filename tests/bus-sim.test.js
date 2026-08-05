// Simulación de flota de buses: f(hora oficial) determinista, como sim.js.
// Corre contra los datos REALES generados (data/bus/patterns.json).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { BusSim } from '../src/bus/bus-sim.js';

const H = (t) => { const [h, m] = t.split(':').map(Number); return h * 3600 + m * 60; };

let sim;
beforeAll(() => {
  const patterns = JSON.parse(readFileSync(new URL('../data/bus/patterns.json', import.meta.url), 'utf8'));
  sim = new BusSim(patterns);
});

describe('BusSim', () => {
  it('carga los 718 patrones con itinerario y bandas', () => {
    expect(sim.patterns.length).toBe(718);
    for (const P of sim.patterns) {
      expect(P.T).toBeGreaterThan(300);        // ningún recorrido dura < 5 min
      expect(P.T).toBeLessThan(4 * 3600);      // ni más de 4 h
      expect(P.sec.length).toBe(P.arc.length); // hora y arco alineados
    }
  });

  it('a mediodía hábil circula una flota del orden de la real (~3.000-6.000)', () => {
    const n = sim.update(H('12:00'), 'wd').length;
    expect(n).toBeGreaterThan(2000);
    expect(n).toBeLessThan(7000);
    expect(sim.count(H('12:00'), 'wd')).toBe(n); // count y update coinciden
  });

  it('en punta hay más buses que en la madrugada', () => {
    const punta = sim.count(H('08:00'), 'wd');
    const noche = sim.count(H('03:00'), 'wd');
    expect(punta).toBeGreaterThan(noche * 3);
    expect(noche).toBeGreaterThan(0); // los servicios nocturnos existen
  });

  it('es determinista: la misma hora produce exactamente los mismos buses', () => {
    const a = sim.update(H('09:30'), 'wd').map((b) => `${b.key}@${b.s.toFixed(1)}`);
    const b = sim.update(H('09:30'), 'wd').map((x) => `${x.key}@${x.s.toFixed(1)}`);
    expect(a).toEqual(b);
  });

  it('cada bus avanza monótonamente y a velocidad de bus real', () => {
    // seguir 25 buses concretos durante 2 minutos simulados
    const t0 = H('12:00');
    const antes = new Map(sim.update(t0, 'wd').map((b) => [b.key, b.s]));
    const muestra = [...antes.keys()].filter((_, i) => i % 100 === 0);
    const despues = new Map(sim.update(t0 + 120, 'wd').map((b) => [b.key, b.s]));
    let seguidos = 0;
    for (const k of muestra) {
      if (!despues.has(k)) continue; // pudo terminar su viaje
      seguidos++;
      const ds = despues.get(k) - antes.get(k);
      expect(ds, k).toBeGreaterThanOrEqual(0);          // nunca retrocede
      expect((ds / 120) * 3.6, k).toBeLessThan(65);     // nunca vuela
    }
    expect(seguidos).toBeGreaterThan(10);
    // y la mediana se mueve de verdad (no es una foto estática)
    const vs = muestra.filter((k) => despues.has(k))
      .map((k) => ((despues.get(k) - antes.get(k)) / 120) * 3.6)
      .sort((x, y) => x - y);
    expect(vs[vs.length >> 1]).toBeGreaterThan(5); // mediana > 5 km/h
  });

  it('la posición interpola el itinerario: llega al final exactamente en T', () => {
    const P = sim.patterns.find((p) => p.route === '506' && p.dir === 'I');
    expect(P).toBeTruthy();
    // un bus recién salido está al inicio; uno a punto de terminar, al final
    const banda = P.freq.wd.find(([a, b]) => H('12:00') >= a && H('12:00') < b);
    expect(banda).toBeTruthy();
    const lista = sim.update(H('12:00'), 'wd').filter((b) => b.route === '506' && b.dir === 'I');
    expect(lista.length).toBeGreaterThan(3); // el 506 va cada ~12 min y tarda ~111
    for (const b of lista) {
      expect(b.s).toBeGreaterThanOrEqual(P.arc[0]);
      expect(b.s).toBeLessThanOrEqual(P.arc[P.arc.length - 1] + 1);
      expect(b.frac).toBeGreaterThanOrEqual(0);
      expect(b.frac).toBeLessThanOrEqual(1);
    }
  });

  // ── estadoDe: es lo que hace posible viajar dentro de un bus ────────────
  describe('estadoDe (cabina)', () => {
    it('resuelve un bus por su key y coincide con la flota completa', () => {
      const t = H('12:00');
      const flota = sim.update(t, 'wd');
      // muestreo amplio: cualquier bus de la flota debe resolverse solo
      for (let i = 0; i < flota.length; i += 137) {
        const b = flota[i];
        const e = sim.estadoDe(b.key, t, 'wd');
        expect(e, b.key).toBeTruthy();
        expect(e.s).toBeCloseTo(b.s, 6);
        expect(e.route).toBe(b.route);
        expect(e.dir).toBe(b.dir);
        expect(e.shape).toBe(b.shape);
      }
    });

    it('devuelve null antes de la salida y después del terminal', () => {
      const b = sim.update(H('12:00'), 'wd')[0];
      const P = sim.patterns.find((p) => p.route === b.route && p.dir === b.dir);
      const [, , a, k] = b.key.split('|');
      const banda = P.freq.wd.find((x) => x[0] === +a);
      const salida = +a + +k * banda[2];
      expect(sim.estadoDe(b.key, salida - 1, 'wd')).toBeNull();     // aún no sale
      expect(sim.estadoDe(b.key, salida, 'wd')).toBeTruthy();       // justo al salir
      expect(sim.estadoDe(b.key, salida + P.T, 'wd')).toBeTruthy(); // justo al llegar
      expect(sim.estadoDe(b.key, salida + P.T + 1, 'wd')).toBeNull(); // ya llegó
      expect(sim.estadoDe(b.key, salida + 60, 'su')).toBeNull();    // ese día no corre esa banda
      expect(sim.estadoDe('no-existe|I|0|0', salida, 'wd')).toBeNull();
      expect(sim.estadoDe('basura', salida, 'wd')).toBeNull();
    });

    it('el viaje avanza de principio a fin sin retroceder ni saltar', () => {
      const b = sim.update(H('12:00'), 'wd').find((x) => x.route === '506' && x.dir === 'I');
      expect(b).toBeTruthy();
      const P = sim.patterns.find((p) => p.route === '506' && p.dir === 'I');
      const [, , a, k] = b.key.split('|');
      const salida = +a + +k * P.freq.wd.find((x) => x[0] === +a)[2];
      let prevS = -1, prevEta = Infinity, prevRest = Infinity, vistos = 0;
      for (let e = 0; e <= P.T; e += 15) {
        const st = sim.estadoDe(b.key, salida + e, 'wd');
        expect(st, `e=${e}`).toBeTruthy();
        expect(st.s).toBeGreaterThanOrEqual(prevS);       // nunca retrocede
        expect(st.v * 3.6).toBeGreaterThanOrEqual(0);
        expect(st.v * 3.6).toBeLessThan(90);              // ni vuela
        expect(st.etaNext).toBeGreaterThanOrEqual(-1e-9); // el próximo siempre por delante
        expect(st.restantes).toBeLessThanOrEqual(prevRest); // los paraderos se van gastando
        if (st.etaNext > prevEta) vistos++;               // subió = se pasó un paradero
        prevS = st.s; prevEta = st.etaNext; prevRest = st.restantes;
      }
      expect(vistos).toBeGreaterThan(30);   // ~91 paraderos en el recorrido
      const fin = sim.estadoDe(b.key, salida + P.T, 'wd');
      expect(fin.frac).toBeCloseTo(1, 6);
      expect(fin.restantes).toBe(1);
      expect(fin.totalStops).toBe(P.st.length);
    });

    it('el próximo paradero y el destino son paraderos reales del recorrido', () => {
      const t = H('08:30');
      for (const b of sim.update(t, 'wd').slice(0, 40)) {
        const st = sim.estadoDe(b.key, t, 'wd');
        const P = sim.patterns.find((p) => p.route === st.route && p.dir === st.dir);
        expect(P.st).toContain(st.nextStop);
        expect(st.destStop).toBe(P.st[P.st.length - 1]);
      }
    });
  });

  it('fuera de las bandas del día no se despacha nada', () => {
    // el sábado usa bandas sa: un patrón sin bandas sa no aporta buses ese día
    const sinSa = sim.patterns.filter((p) => !(p.freq.sa || []).length);
    if (!sinSa.length) return; // si todos operan sábado, no hay qué probar
    const rutas = new Set(sinSa.map((p) => `${p.route}|${p.dir}`));
    const activos = sim.update(H('12:00'), 'sa');
    for (const b of activos) {
      expect(rutas.has(`${b.route}|${b.dir}`), `${b.route} no opera sábado`).toBe(false);
    }
  });
});
