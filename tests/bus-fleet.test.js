// Cliente y parseo del feed AVL de flota. Como con xor-client, CI no toca la
// red: la fixture son 50 buses reales grabados del feed en producción.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FleetClient, parseFleet, parseRouteCode } from '../src/bus/fleet-client.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/avl/fleet.json', import.meta.url), 'utf8'));

function reloj(t0 = 5_000_000) {
  let t = t0;
  return { now: () => t, avanzar: (ms) => { t += ms; } };
}

describe('parseFleet', () => {
  it('extrae patente, posición y hora de medición de cada bus', () => {
    const buses = parseFleet(fixture);
    expect(buses.size).toBeGreaterThan(40);
    for (const [plate, b] of buses) {
      expect(plate).toMatch(/^[A-Z]{4}-\d{2}$/);
      expect(b.lat).toBeGreaterThan(-34.3);
      expect(b.lat).toBeLessThan(-33.0);
      expect(b.lon).toBeGreaterThan(-71.5);
      expect(b.lon).toBeLessThan(-70.3);
      expect(Number.isFinite(b.ts)).toBe(true); // cada bus lleva SU hora
      expect(b.dir).toMatch(/^[IR]$/);
    }
  });

  it('descarta GPS basura sin descartar el lote', () => {
    const roto = {
      geojson: {
        features: [
          ...fixture.geojson.features.slice(0, 3),
          { properties: { license_plate: 'XXXX-01', timestamp: '2026-08-04T00:00:00+0000' }, geometry: { coordinates: [0, 0] } },
          { properties: { license_plate: 'XXXX-02', timestamp: 'no-es-fecha' }, geometry: { coordinates: [-70.6, -33.4] } },
          { properties: {}, geometry: { coordinates: [-70.6, -33.4] } },
        ],
      },
    };
    const buses = parseFleet(roto);
    expect(buses.size).toBe(3);
    expect(buses.has('XXXX-01')).toBe(false); // (0,0) no es Santiago
    expect(buses.has('XXXX-02')).toBe(false); // sin hora no hay medición
  });

  it('tolera formas raras sin lanzar', () => {
    for (const raro of [null, {}, { geojson: {} }, { features: 'x' }]) {
      expect(parseFleet(raro).size).toBe(0);
    }
  });
});

describe('parseRouteCode', () => {
  const known = new Set(['506', 'J01', '101', 'B26']);
  it('reconoce códigos con route_id del GTFS', () => {
    expect(parseRouteCode('506 00I', known)).toBe('506');
    expect(parseRouteCode('J01 00R', known)).toBe('J01');
    expect(parseRouteCode('101', known)).toBe('101');
  });
  it('los códigos internos T#### devuelven null, no un invento', () => {
    expect(parseRouteCode('T1451 00I', known)).toBe(null);
    expect(parseRouteCode('', known)).toBe(null);
    expect(parseRouteCode(null, known)).toBe(null);
  });
});

describe('FleetClient: política de tasa', () => {
  const cliente = (impl, clock, extra = {}) => new FleetClient({ fetch: impl, now: clock.now, ...extra });
  const okRes = { ok: true, json: async () => fixture };

  it('una petición trae toda la flota', async () => {
    const calls = [];
    const c = cliente(async (u) => { calls.push(u); return okRes; }, reloj());
    const r = await c.query();
    expect(r.ok).toBe(true);
    expect(r.buses.size).toBeGreaterThan(40);
    expect(calls.length).toBe(1);
  });

  it('no repregunta ante del minuto: el upstream refresca en lotes lentos', async () => {
    const calls = [];
    const clock = reloj();
    const c = cliente(async (u) => { calls.push(u); return okRes; }, clock);
    await c.query();
    const r2 = await c.query();
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('muy-pronto');
    expect(calls.length).toBe(1);
    clock.avanzar(61000);
    expect((await c.query()).ok).toBe(true);
    expect(c.espera()).toBeGreaterThan(50000); // y vuelve a esperar
  });

  it('un 200 sin buses es un fallo, no "cero buses en Santiago"', async () => {
    const clock = reloj();
    const c = cliente(async () => ({ ok: true, json: async () => ({ geojson: { features: [] } }) }), clock);
    const r = await c.query();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('vacio');
  });

  it('tres fallos abren el circuito', async () => {
    const clock = reloj();
    const calls = [];
    const c = cliente(async (u) => { calls.push(u); return { ok: false, status: 503, json: async () => null }; }, clock);
    for (let i = 0; i < 3; i++) { await c.query(); clock.avanzar(61000); }
    const r = await c.query();
    expect(r.reason).toBe('circuito-abierto');
    expect(calls.length).toBe(3);
  });

  it('el tope de sesión corta', async () => {
    const clock = reloj();
    const c = cliente(async () => okRes, clock, { sessionCap: 2 });
    await c.query(); clock.avanzar(61000);
    await c.query(); clock.avanzar(61000);
    expect((await c.query()).reason).toBe('tope-de-sesion');
  });
});
