// Cliente del feed AVL de flota completa (velocidades.seguimos.cl).
//
// Es el SEGUNDO y último archivo del proyecto autorizado a llamar a la red
// (el otro es xor-client.js), y como aquél, la política de tasa vive aquí y
// no en quien llama.
//
// POR QUÉ ESTE FEED Y NO UN BARRIDO DE PARADEROS
// La API de paraderos entrega solo los ~2 buses siguientes por paradero: un
// "mapa de toda la ciudad" armado con ella sería una muestra presentada como
// flota, y costaría decenas de peticiones por minuto contra el proyecto de
// una persona. Este feed entrega la flota completa (~5.000 buses con GPS,
// patente y timestamp POR BUS) en UNA petición. Un visitante = 1 req/min.
//
// QUÉ ES ESTE DATO Y QUÉ NO ES
// Posiciones GPS reales reportadas por los buses, con su hora de medición.
// No es fresco al segundo: la edad mediana medida es ~2 min. Por eso el
// parseo conserva el timestamp de CADA bus — la edad se dibuja, no se tapa.
//
// ADVERTENCIA DE ORIGEN
// Es un tercero sin términos publicados ni garantía de continuidad. Si el
// feed muere, el modo flota dice "sin datos" y el resto de metrovivo sigue
// intacto: nada más depende de él.

const URL_FLOTA = 'https://velocidades.seguimos.cl/?all-buses-data=1';

const TIMEOUT_MS = 30000;      // el cuerpo pesa ~1 MB (viaja en brotli, ~100 KB)
// Medido (2026-08-04, 5 fotos a 70 s): cada bus reporta más o menos cada
// minuto — el 73 % de los timestamps se renueva entre fotos, y el dato más
// nuevo tiene ~1 s. Pero el upstream puede servir una respuesta cacheada
// (dos fotos a 50 s llegaron idénticas), así que pedir bajo 60 s a veces solo
// repite bytes. Un sondeo por minuto captura casi todo lo que existe.
const MIN_INTERVAL_MS = 60000;
const BREAKER_FAILS = 3;
const BREAKER_COOLDOWN_MS = 180000;
const SESSION_CAP = 90;        // ~1 h de flota continua por carga de página

export class FleetClient {
  constructor(opts = {}) {
    this.url = opts.url || URL_FLOTA;
    this.fetchImpl = opts.fetch || ((...a) => fetch(...a));
    this.now = opts.now || (() => Date.now());
    this.minInterval = opts.minInterval ?? MIN_INTERVAL_MS;
    this.sessionCap = opts.sessionCap ?? SESSION_CAP;

    this._last = 0;
    this._fails = 0;
    this._openUntil = 0;
    this._inflight = null;
    this.sent = 0;
    this.paused = false;

    if (typeof document !== 'undefined') {
      this._onVis = () => { this.paused = document.visibilityState === 'hidden'; };
      document.addEventListener('visibilitychange', this._onVis);
      this._onVis();
    }
  }

  dispose() {
    if (this._onVis && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVis);
    }
  }

  check() {
    const t = this.now();
    if (this.paused) return 'pausado';
    if (this.sent >= this.sessionCap) return 'tope-de-sesion';
    if (t < this._openUntil) return 'circuito-abierto';
    if (t - this._last < this.minInterval) return 'muy-pronto';
    return 'ok';
  }

  /** ms hasta que se pueda volver a pedir (para programar el siguiente sondeo). */
  espera() { return Math.max(0, this._last + this.minInterval - this.now()); }

  /**
   * Pide la flota completa. Nunca lanza.
   * → { ok: true, buses: Map<plate, Bus>, fetchedAtWall }
   * → { ok: false, reason }
   * Bus: { lon, lat, ts, speed, route, dir }  · ts = hora de MEDICIÓN del GPS
   */
  async query() {
    if (this._inflight) return this._inflight;
    const gate = this.check();
    if (gate !== 'ok') return { ok: false, reason: gate };

    this._last = this.now();
    this.sent += 1;
    this._inflight = this._do().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _do() {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(this.url, {
        signal: ac.signal,
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'origin',
      });
      if (!res.ok) return this._fallo('http');
      const json = await res.json();
      const buses = parseFleet(json);
      if (!buses.size) return this._fallo('vacio'); // 200 con nada = fallo, no "cero buses"
      this._fails = 0;
      return { ok: true, buses, fetchedAtWall: Date.now() };
    } catch (e) {
      const abortado = e?.name === 'AbortError' || ac.signal.aborted;
      return this._fallo(abortado ? 'timeout' : 'red');
    } finally {
      clearTimeout(timer);
    }
  }

  _fallo(reason) {
    this._fails += 1;
    if (this._fails >= BREAKER_FAILS) {
      this._openUntil = this.now() + BREAKER_COOLDOWN_MS;
      this._fails = 0;
    }
    return { ok: false, reason };
  }

  stats() {
    return {
      enviadas: this.sent,
      tope: this.sessionCap,
      circuitoAbierto: this.now() < this._openUntil,
      pausado: this.paused,
    };
  }
}

/** GeoJSON del feed → Map por patente. Exportada para testearla con fixtures. */
export function parseFleet(json) {
  const feats = (json?.geojson || json)?.features || [];
  const out = new Map();
  for (const f of feats) {
    const p = f?.properties || {};
    const g = f?.geometry;
    const plate = String(p.license_plate || '').toUpperCase();
    if (!plate || !Array.isArray(g?.coordinates)) continue;
    const lon = +g.coordinates[0], lat = +g.coordinates[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    // caja del Gran Santiago: un GPS en (0,0) o en Valparaíso es basura, no dato
    if (lat < -34.3 || lat > -33.0 || lon < -71.5 || lon > -70.3) continue;
    const ts = Date.parse(p.timestamp);
    if (!Number.isFinite(ts)) continue;
    out.set(plate, {
      lon, lat, ts,
      speed: Number.isFinite(+p.speed) ? +p.speed : null,
      route: String(p.route_code || '').trim(),
      dir: p.route_direction === 'Regreso' ? 'R' : 'I',
    });
  }
  return out;
}

/**
 * "T1451 00I" / "101 00I" / "506 00R" → route_id del GTFS si se reconoce.
 * Los códigos T#### son internos de operador y no siempre tienen equivalente
 * usuario; en ese caso se devuelve null y el bus se muestra sin servicio.
 */
export function parseRouteCode(routeCode, knownRoutes) {
  const base = String(routeCode || '').trim().split(/\s+/)[0].toUpperCase();
  if (!base) return null;
  if (knownRoutes.has(base)) return base;
  // variantes con sufijo pegado: "506E", "N01" — probar sin el último carácter
  if (base.length > 1 && knownRoutes.has(base.slice(0, -1))) return base.slice(0, -1);
  return null;
}
