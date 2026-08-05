// Ubicación de buses. Lo que más importa aquí no es que acierte, sino que se
// ABSTENGA: cada abstención es un caso en que dibujar el bus daría un punto
// plausible y equivocado, que es peor que no dibujar nada.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { StopCatalog } from '../src/bus/catalog.js';
import { BusPlacer, MOTIVOS, decodePolyline, EDAD_BASE_MS } from '../src/bus/placement.js';

const leer = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

let network, catalog, placer;
beforeAll(() => {
  network = leer('../data/network.json');
  catalog = new StopCatalog(leer('../data/bus/stops.json'), network.projection);
  catalog.loadNames(leer('../data/bus/names.json'));
  placer = new BusPlacer(leer('../data/bus/patterns.json'), leer('../data/bus/shapes.json'), catalog, network.projection);
});

/** Un (servicio, sentido) real con al menos 6 paraderos, para armar casos. */
function muestra() {
  for (const [svc, dirs] of Object.entries(placer.patterns)) {
    for (const d of ['I', 'R']) {
      const p = dirs[d];
      if (p && p.st.length >= 6) return { svc, dir: d, pat: p, arcs: placer.arcos(svc, d) };
    }
  }
  throw new Error('sin patrones utilizables');
}

describe('catálogo de paraderos', () => {
  it('los códigos calzan con el regex que la propia API usa para validar', () => {
    const re = /^[Pp][A-Ja-j][0-9]{1,5}$/;
    const malos = catalog.codes.filter((c) => !re.test(c));
    expect(malos, `códigos que la API rechazaría: ${malos.slice(0, 5)}`).toEqual([]);
  });

  it('cada paradero tiene nombre y cae dentro del Gran Santiago', () => {
    expect(catalog.names.length).toBe(catalog.size);
    for (let i = 0; i < catalog.size; i += 500) {
      expect(catalog.names[i].length, catalog.codes[i]).toBeGreaterThan(0);
      expect(catalog.lat[i]).toBeGreaterThan(-34.2);
      expect(catalog.lat[i]).toBeLessThan(-32.9);
      expect(catalog.lon[i]).toBeGreaterThan(-71.4);
      expect(catalog.lon[i]).toBeLessThan(-70.2);
    }
  });

  it('el nombre ya no arrastra el prefijo del código', () => {
    for (let i = 0; i < catalog.size; i += 97) {
      expect(catalog.names[i].startsWith(catalog.codes[i]), catalog.codes[i]).toBe(false);
    }
  });

  it('la búsqueda por cercanía devuelve el paradero exacto sobre su posición', () => {
    for (const c of ['PA1', 'PD1', 'PJ1']) {
      const i = catalog.index(c);
      const p = catalog.position(i);
      expect(catalog.nearest(p.x, p.z, 50).i).toBe(i);
    }
  });
});

describe('BusPlacer: ubicación', () => {
  it('un bus a 0 m queda exactamente en el paradero', () => {
    const { svc, dir, pat, arcs } = muestra();
    const k = 3;
    const stopCode = catalog.code(pat.st[k]);
    const r = placer.locate([{ stopCode, service: svc, meters: 0 }]);
    expect(r.ok, r.motivo).toBe(true);
    expect(r.dir).toBe(dir);
    expect(r.s).toBeCloseTo(arcs[k], 0);
    const p = catalog.position(pat.st[k]);
    // el paradero puede estar unos metros al costado de la calzada
    expect(Math.hypot(r.x - p.x, r.z - p.z)).toBeLessThan(60);
  });

  it('los metros de la API se descuentan sobre el recorrido, no en línea recta', () => {
    const { svc, pat, arcs } = muestra();
    const k = 4, metros = 300;
    const r = placer.locate([{ stopCode: catalog.code(pat.st[k]), service: svc, meters: metros }]);
    expect(r.ok).toBe(true);
    expect(r.s).toBeCloseTo(arcs[k] - metros, 0);
    // y la distancia RECTA hasta el paradero nunca puede superar los metros
    // declarados: por una curva siempre se recorre más que en línea recta
    const p = catalog.position(pat.st[k]);
    expect(Math.hypot(r.x - p.x, r.z - p.z)).toBeLessThanOrEqual(metros + 1);
  });

  it('el punto ubicado cae sobre el trazado del servicio', () => {
    const { svc, pat, arcs } = muestra();
    const r = placer.locate([{ stopCode: catalog.code(pat.st[5]), service: svc, meters: 500 }]);
    expect(r.ok).toBe(true);
    const t = placer.trazado(r.shapeId);
    let dmin = Infinity;
    for (let i = 1; i < t.x.length; i++) {
      const ax = t.x[i - 1], az = t.z[i - 1];
      const dx = t.x[i] - ax, dz = t.z[i] - az;
      const l2 = dx * dx + dz * dz || 1e-9;
      let u = ((r.x - ax) * dx + (r.z - az) * dz) / l2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      dmin = Math.min(dmin, Math.hypot(r.x - (ax + dx * u), r.z - (az + dz * u)));
    }
    expect(dmin).toBeLessThan(1);
    expect(arcs.length).toBe(pat.st.length);
  });
});

describe('BusPlacer: las abstenciones', () => {
  it('servicio que no está en el GTFS vigente', () => {
    // 413c aparece hoy en la API y no existe en routes.txt
    const r = placer.locate([{ stopCode: 'PA1', service: '413c', meters: 100 }]);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe(MOTIVOS.SERVICIO_DESCONOCIDO);
    expect(r.explicacion).toBeTruthy();
  });

  it('paradero que no pertenece al recorrido', () => {
    const { svc, pat } = muestra();
    const ajeno = catalog.codes.find((c) => !pat.st.includes(catalog.index(c))
      && !(placer.patterns[svc].I?.st ?? []).includes(catalog.index(c))
      && !(placer.patterns[svc].R?.st ?? []).includes(catalog.index(c)));
    const r = placer.locate([{ stopCode: ajeno, service: svc, meters: 100 }]);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe(MOTIVOS.PARADERO_FUERA);
  });

  it('bus antes del inicio del trazado que conocemos', () => {
    const { svc, pat, arcs } = muestra();
    // más metros de los que hay entre el inicio y ese paradero
    const r = placer.locate([{ stopCode: catalog.code(pat.st[1]), service: svc, meters: arcs[1] + 5000 }]);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe(MOTIVOS.ANTES_DEL_INICIO);
  });

  it('observaciones incoherentes entre paraderos: no se promedia, se abstiene', () => {
    const { svc, pat, arcs } = muestra();
    // dos paraderos que sitúan el bus a más de 250 m de distancia entre sí
    const obs = [
      { stopCode: catalog.code(pat.st[2]), service: svc, meters: 100 },
      { stopCode: catalog.code(pat.st[4]), service: svc, meters: arcs[4] - arcs[2] + 100 + 900 },
    ];
    const r = placer.locate(obs);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe(MOTIVOS.DISPERSION);
    expect(r.spread).toBeGreaterThan(250);
  });

  it('sin distancia no se inventa una posición', () => {
    const { svc, pat } = muestra();
    const r = placer.locate([{ stopCode: catalog.code(pat.st[0]), service: svc, meters: null }]);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe(MOTIVOS.SIN_METROS);
  });

  it('dos observaciones coherentes SÍ ubican, y con menos incertidumbre', () => {
    const { svc, pat, arcs } = muestra();
    const obs = [
      { stopCode: catalog.code(pat.st[2]), service: svc, meters: 200 },
      { stopCode: catalog.code(pat.st[4]), service: svc, meters: arcs[4] - arcs[2] + 200 },
    ];
    const r = placer.locate(obs);
    expect(r.ok).toBe(true);
    expect(r.n).toBe(2);
    expect(r.spread).toBeLessThan(5);
  });
});

describe('banda de incertidumbre', () => {
  it('nace con la edad del backend encima, aunque la lectura sea recién traída', () => {
    const b = placer.banda(1000, 0);
    expect(b.desde).toBe(1000);
    // el backend refresca cada ~33 s: incluso a edad 0 hay margen
    expect(b.hasta - b.desde).toBeGreaterThan((EDAD_BASE_MS / 1000) * 10);
  });

  it('crece con el tiempo y sólo hacia adelante: el bus no retrocede', () => {
    const a = placer.banda(1000, 0);
    const b = placer.banda(1000, 60000);
    expect(b.hasta).toBeGreaterThan(a.hasta);
    expect(b.desde).toBe(1000);
    // a 50 km/h de tope, un minuto son ~830 m
    expect(b.hasta - a.hasta).toBeGreaterThan(700);
    expect(b.hasta - a.hasta).toBeLessThan(1000);
  });
});

describe('polilíneas', () => {
  it('decodifican a coordenadas del Gran Santiago', () => {
    const [id, enc] = Object.entries(placer.rawShapes)[0];
    const pts = decodePolyline(enc);
    expect(pts.length, id).toBeGreaterThan(10);
    for (const [lat, lon] of [pts[0], pts[pts.length - 1]]) {
      expect(lat).toBeGreaterThan(-34.2);
      expect(lat).toBeLessThan(-32.9);
      expect(lon).toBeGreaterThan(-71.4);
      expect(lon).toBeLessThan(-70.2);
    }
  });

  it('el largo del trazado concuerda con el arco del último paradero', () => {
    const { svc, dir, pat, arcs } = muestra();
    const t = placer.trazado(pat.shape);
    expect(t.len).toBeCloseTo(pat.len, -1);
    expect(arcs[arcs.length - 1]).toBeLessThanOrEqual(t.len + 1);
    expect(dir).toMatch(/^[IR]$/);
  });
});
