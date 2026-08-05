// Cliente y provider de buses. CI no toca la API real: todo sale de
// respuestas grabadas en tests/fixtures/xor/, sobre todo las de FALLO, que
// son las que deciden si la interfaz miente o no.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { XorClient } from '../src/bus/xor-client.js';
import { BusStopProvider, ESTADOS } from '../src/bus/provider.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/xor/${n}.json`, import.meta.url), 'utf8'));

/** fetch de mentira: devuelve lo que se le diga y cuenta las llamadas. */
function fakeFetch(plan) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push(url);
    const r = typeof plan === 'function' ? plan(url, calls.length) : plan;
    if (r instanceof Error) throw r;
    if (r.abort) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      // simula que el AbortController del cliente ya disparó
      await new Promise((res) => setTimeout(res, 0));
      throw e;
    }
    return {
      status: r.status ?? 200,
      json: async () => {
        if (r.badJson) throw new Error('not json');
        return r.body;
      },
    };
  };
  return { impl, calls };
}

// reloj controlable: sin él, los tests de tasa dependerían de dormir de verdad
function reloj(t0 = 1_000_000) {
  let t = t0;
  return { now: () => t, avanzar: (ms) => { t += ms; } };
}

const nuevoCliente = (impl, clock, extra = {}) => new XorClient({
  fetch: impl, now: clock.now, minInterval: 20000, ...extra,
});

describe('XorClient: política de tasa', () => {
  it('deja pasar la primera petición de un código', async () => {
    const { impl, calls } = fakeFetch({ body: fixture('ok-con-buses') });
    const c = nuevoCliente(impl, reloj());
    const r = await c.query('PA1');
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('respeta el piso por paradero: no repregunta antes de 20 s', async () => {
    const { impl, calls } = fakeFetch({ body: fixture('ok-con-buses') });
    const clock = reloj();
    const c = nuevoCliente(impl, clock);
    await c.query('PA1');
    const r2 = await c.query('PA1');
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('muy-pronto');
    expect(calls.length).toBe(1); // no salió a la red

    clock.avanzar(25000);
    const r3 = await c.query('PA1');
    expect(r3.ok).toBe(true);
    expect(calls.length).toBe(2);
  });

  it('el cubo de fichas limita la ráfaga y se rellena con el tiempo', async () => {
    const { impl, calls } = fakeFetch({ body: fixture('ok-con-buses') });
    const clock = reloj();
    const c = nuevoCliente(impl, clock);
    // 4 códigos distintos entran (capacidad del cubo); el quinto no
    for (const code of ['PA1', 'PA2', 'PA3', 'PA4']) {
      expect((await c.query(code)).ok, code).toBe(true);
    }
    const quinto = await c.query('PA5');
    expect(quinto.ok).toBe(false);
    expect(quinto.reason).toBe('sin-cupo');
    expect(calls.length).toBe(4);

    clock.avanzar(3000); // una ficha
    expect((await c.query('PA5')).ok).toBe(true);
    expect(calls.length).toBe(5);
  });

  it('deduplica peticiones simultáneas al mismo paradero', async () => {
    let resolver;
    const espera = new Promise((res) => { resolver = res; });
    const calls = [];
    const impl = async (url) => {
      calls.push(url);
      await espera;
      return { status: 200, json: async () => fixture('ok-con-buses') };
    };
    const c = nuevoCliente(impl, reloj());
    const a = c.query('PA1');
    const b = c.query('PA1');
    resolver();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(calls.length).toBe(1); // una sola ida a la red
  });

  it('el tope de sesión corta y no se puede rebasar', async () => {
    const { impl, calls } = fakeFetch({ body: fixture('ok-con-buses') });
    const clock = reloj();
    const c = nuevoCliente(impl, clock, { sessionCap: 3 });
    for (let i = 0; i < 3; i++) {
      clock.avanzar(4000);
      expect((await c.query(`P${i}`)).ok).toBe(true);
    }
    clock.avanzar(4000);
    const r = await c.query('PX');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tope-de-sesion');
    expect(calls.length).toBe(3);
  });

  it('cinco fallos seguidos abren el circuito', async () => {
    const clock = reloj();
    const { impl, calls } = fakeFetch({ status: 503, body: null });
    const c = nuevoCliente(impl, clock);
    for (let i = 0; i < 5; i++) {
      clock.avanzar(4000);
      const r = await c.query(`P${i}`);
      expect(r.ok).toBe(false);
    }
    clock.avanzar(4000);
    const r = await c.query('POTRO');
    expect(r.reason).toBe('circuito-abierto');
    expect(calls.length).toBe(5); // el sexto ni se intentó
  });

  it('una respuesta buena reinicia la cuenta de fallos', async () => {
    const clock = reloj();
    let fallar = true;
    const impl = async () => (fallar
      ? { status: 503, json: async () => null }
      : { status: 200, json: async () => fixture('ok-con-buses') });
    const c = nuevoCliente(impl, clock);
    for (let i = 0; i < 4; i++) { clock.avanzar(4000); await c.query(`P${i}`); }
    fallar = false;
    clock.avanzar(4000);
    expect((await c.query('PBUENO')).ok).toBe(true);
    fallar = true;
    for (let i = 0; i < 4; i++) { clock.avanzar(4000); await c.query(`Q${i}`); }
    clock.avanzar(4000);
    // van 4 fallos tras el reinicio: el circuito sigue cerrado
    expect((await c.query('QX')).reason).not.toBe('circuito-abierto');
  });

  it('un 400 con cuerpo JSON es respuesta válida, no un fallo del servicio', async () => {
    const clock = reloj();
    const { impl } = fakeFetch({ status: 400, body: fixture('status-20-upstream') });
    const c = nuevoCliente(impl, clock);
    for (let i = 0; i < 6; i++) {
      clock.avanzar(4000);
      const r = await c.query(`P${i}`);
      expect(r.ok, 'el 400 con JSON debe llegar a quien llama').toBe(true);
      expect(r.json.status_code).toBe(20);
    }
    // seis "fallos" de ese tipo NO abrieron el circuito
    clock.avanzar(4000);
    expect((await c.query('PZ')).reason).not.toBe('circuito-abierto');
  });
});

describe('BusStopProvider: los seis desenlaces', () => {
  const provider = (impl, clock = reloj()) => new BusStopProvider(nuevoCliente(impl, clock));

  it('ok: buses reales con patente, metros y ventana', async () => {
    const { impl } = fakeFetch({ body: fixture('ok-con-buses') });
    const l = await provider(impl).query('PA1');
    expect(l.state).toBe(ESTADOS.OK);
    expect(l.buses.length).toBeGreaterThan(0);
    for (const b of l.buses) {
      expect(b.plate).toMatch(/^[A-Z]{4}-\d{2}$/);
      expect(b.meters).toBeGreaterThanOrEqual(0);
      expect(b.service).toBeTruthy();
    }
  });

  it('sin-datos: la API respondió bien y no hay buses (de madrugada es lo correcto)', async () => {
    const { impl } = fakeFetch({ body: fixture('ok-sin-buses') });
    const l = await provider(impl).query('PA1');
    expect(l.state).toBe(ESTADOS.SIN_DATOS);
    expect(l.buses).toEqual([]);
    expect(l.message).toMatch(/sin buses/i);
  });

  it('upstream-caido: status 20 NO se presenta como "el paradero no existe"', async () => {
    // PA433 está en el GTFS oficial y aun así devuelve 20
    const { impl } = fakeFetch({ status: 400, body: fixture('status-20-upstream') });
    const l = await provider(impl).query('PA433');
    expect(l.state).toBe(ESTADOS.UPSTREAM_CAIDO);
    expect(l.message).not.toMatch(/no existe|inválid|desconocid/i);
  });

  it('codigo-rechazado: status 12 sí es un código mal formado', async () => {
    const { impl } = fakeFetch({ status: 400, body: fixture('status-12-rechazado') });
    const l = await provider(impl).query('PT101');
    expect(l.state).toBe(ESTADOS.CODIGO_RECHAZADO);
  });

  it('red-inalcanzable y timeout se distinguen entre sí', async () => {
    const caida = await provider(async () => { throw new TypeError('Failed to fetch'); }).query('PA1');
    expect(caida.state).toBe(ESTADOS.RED_INALCANZABLE);

    const lento = await provider(async () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    }).query('PA1');
    expect(lento.state).toBe(ESTADOS.TIMEOUT);
  });

  it('un fallo NUNCA sobrescribe una lectura buena como si fuera fresca', async () => {
    const clock = reloj();
    let caer = false;
    const impl = async () => {
      if (caer) throw new TypeError('Failed to fetch');
      return { status: 200, json: async () => fixture('ok-con-buses') };
    };
    const p = provider(impl, clock);
    const buena = await p.query('PA1');
    expect(buena.state).toBe(ESTADOS.OK);

    caer = true;
    clock.avanzar(25000);
    const mala = await p.query('PA1');
    expect(mala.state).toBe(ESTADOS.RED_INALCANZABLE);
    expect(mala.buses).toEqual([]);            // no inventa buses
    expect(mala.previa).toBeTruthy();          // pero conserva la anterior
    expect(mala.previa.fetchedAtWall).toBe(buena.fetchedAtWall); // CON SU HORA
    expect(p.ultima('PA1').fetchedAtWall).toBe(buena.fetchedAtWall);
  });

  it('corrige el doble encode de la API ("HÃ¡bil" → "Hábil")', async () => {
    const { impl } = fakeFetch({ body: fixture('ok-con-buses') });
    const l = await provider(impl).query('PA1');
    const notas = l.services.map((s) => s.note).join(' ');
    expect(notas).not.toMatch(/Ã/);
    if (/horario/i.test(notas)) expect(notas).toMatch(/Hábil|hábil/);
  });

  it('fecha la lectura con el reloj de pared, no con el de la simulación', async () => {
    const { impl } = fakeFetch({ body: fixture('ok-con-buses') });
    const antes = Date.now();
    const l = await provider(impl).query('PA1');
    expect(l.fetchedAtWall).toBeGreaterThanOrEqual(antes);
    expect(l.fetchedAtWall).toBeLessThanOrEqual(Date.now());
  });
});
