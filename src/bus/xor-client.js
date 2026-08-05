// El ÚNICO lugar del proyecto que llama a la red.
//
// Todo lo demás (provider, panel, capa 3D) pasa por aquí, y aquí vive la
// política de tasa entera. No es una precaución de estilo: api.xor.cl es el
// proyecto GPL-3.0 de una persona, cada petición nuestra golpea por detrás a
// red.cl/SMSBus, y metrovivo es un sitio estático sin backend — o sea que no
// hay caché compartida y N visitantes son N× tráfico, con un Referer de
// github.io perfectamente identificable. Que no haya rate limit medido no es
// un permiso.
//
// Por eso el presupuesto se aplica en el transporte y no en quien llama: si
// estuviera repartido por la app, cualquier ruta de código nueva podría
// esquivarlo sin querer.

const BASE = 'https://api.xor.cl/red/bus-stop/';

const TIMEOUT_MS = 8000;      // corta antes de que el usuario crea que se colgó
const BUCKET_CAP = 4;         // ráfaga máxima (elegir un paradero tras otro)
const BUCKET_REFILL_MS = 3000;// régimen sostenido: 1 petición cada 3 s
const MIN_INTERVAL_MS = 20000;// piso por paradero: el backend refresca cada ~33 s
const JITTER_MS = 4000;       // desincroniza pestañas abiertas a la vez
const BREAKER_FAILS = 5;      // fallos seguidos que abren el circuito
const BREAKER_COOLDOWN_MS = 120000;
const SESSION_CAP = 600;      // tope duro por carga de página

export class XorClient {
  constructor(opts = {}) {
    this.base = opts.base || BASE;
    this.fetchImpl = opts.fetch || ((...a) => fetch(...a));
    this.now = opts.now || (() => Date.now());
    this.sessionCap = opts.sessionCap ?? SESSION_CAP;
    this.minInterval = opts.minInterval ?? MIN_INTERVAL_MS;

    this._tokens = BUCKET_CAP;
    this._lastRefill = this.now();
    this._lastByCode = new Map();  // code → ms de la última petición lanzada
    this._inflight = new Map();    // code → Promise (dedupe)
    this._fails = 0;
    this._openUntil = 0;
    this.sent = 0;
    this.paused = false;

    // Pestaña oculta: cero peticiones. Una pestaña de fondo consumiendo la API
    // de otro es el caso que más fácil se cuela y más difícil de notar.
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

  /** ¿Se puede pedir este código ahora mismo, y si no, por qué? */
  check(code) {
    const t = this.now();
    if (this.paused) return 'pausado';
    if (this.sent >= this.sessionCap) return 'tope-de-sesion';
    if (t < this._openUntil) return 'circuito-abierto';
    const last = this._lastByCode.get(code);
    if (last !== undefined && t - last < this.minInterval) return 'muy-pronto';
    this._refill(t);
    if (this._tokens < 1) return 'sin-cupo';
    return 'ok';
  }

  _refill(t) {
    const ganados = Math.floor((t - this._lastRefill) / BUCKET_REFILL_MS);
    if (ganados > 0) {
      this._tokens = Math.min(BUCKET_CAP, this._tokens + ganados);
      this._lastRefill += ganados * BUCKET_REFILL_MS;
    }
  }

  /**
   * Pide un paradero.
   * → { ok: true, json } | { ok: false, reason, detail? }
   * reason: 'timeout' | 'red' | 'http' | 'json' | <lo que devuelva check()>
   *
   * Nunca lanza: quien llama decide qué mostrar, y un throw suelto en un
   * bucle de UI acaba en un catch que colapsa todos los motivos en uno.
   */
  async query(code, { signal } = {}) {
    // La dedupe va ANTES de la política de tasa: si ya hay una petición en
    // vuelo para este código, la respuesta correcta es esa misma promesa, no
    // un 'muy-pronto' por el piso que acaba de marcar ella. Al revés, este
    // camino sería inalcanzable y dos vistas del mismo paradero se quedarían
    // una sin datos.
    const enCurso = this._inflight.get(code);
    if (enCurso) return enCurso;

    const gate = this.check(code);
    if (gate !== 'ok') return { ok: false, reason: gate };

    this._tokens -= 1;
    this._lastByCode.set(code, this.now() + Math.random() * JITTER_MS);
    this.sent += 1;

    const p = this._do(code, signal).finally(() => this._inflight.delete(code));
    this._inflight.set(code, p);
    return p;
  }

  async _do(code, signal) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), TIMEOUT_MS);
    const onAbort = () => ac.abort('externo');
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await this.fetchImpl(this.base + encodeURIComponent(code), {
        signal: ac.signal,
        headers: { Accept: 'application/json' },
        // sin credenciales ni cookies: no somos un cliente identificado
        credentials: 'omit',
        referrerPolicy: 'origin',
      });

      // 400 con cuerpo JSON es una respuesta LEGÍTIMA de esta API (status_code
      // 12 y 20 viajan con 400). Sólo 5xx y 429 cuentan como fallo del servicio.
      let json = null;
      try { json = await res.json(); } catch { /* cuerpo no-JSON */ }

      if (json && typeof json.status_code === 'number') {
        this._fails = 0;
        return { ok: true, json };
      }
      if (res.status === 429 || res.status >= 500) {
        return this._fallo({ ok: false, reason: 'http', detail: String(res.status) });
      }
      return this._fallo({ ok: false, reason: 'json', detail: `HTTP ${res.status}` });
    } catch (e) {
      const abortado = e?.name === 'AbortError' || ac.signal.aborted;
      if (abortado && ac.signal.reason === 'externo') return { ok: false, reason: 'cancelado' };
      return this._fallo({ ok: false, reason: abortado ? 'timeout' : 'red', detail: String(e?.message || e) });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  _fallo(r) {
    this._fails += 1;
    if (this._fails >= BREAKER_FAILS) {
      this._openUntil = this.now() + BREAKER_COOLDOWN_MS;
      this._fails = 0;
    }
    return r;
  }

  /** Para el panel de depuración. */
  stats() {
    return {
      enviadas: this.sent,
      tope: this.sessionCap,
      cupo: Math.floor(this._tokens),
      circuitoAbierto: this.now() < this._openUntil,
      pausado: this.paused,
    };
  }
}
