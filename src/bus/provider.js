// BusStopProvider: la costura de los buses, análoga a src/provider.js.
//
// DIFERENCIA DELIBERADA CON ScheduleProvider: aquí NO existe update(sec, day).
// Ese contrato corre por frame, y una firma por frame es la puerta de entrada
// a llamar a la red desde el bucle de render. Este provider se consulta con
// query(code), y quien lo llama decide cuándo.
//
// LOS SEIS DESENLACES
// El README del proyecto sostiene que un "todo normal" falso es peor que no
// tener datos, y el ejemplo canónico está en la misma API: /red/metro-network
// devuelve 200 con `lines: []` desde hace años. Aquí ese error se evita
// distinguiendo seis estados que un try/catch colapsaría en uno solo:
//
//   ok               · hay lectura y hay buses
//   sin-datos        · la API respondió bien y no hay buses en camino
//                      (de madrugada es lo correcto, no un fallo)
//   upstream-caido   · status_code 20. NO significa "no existe": PA433 y
//                      PB2216 están en el GTFS oficial y devuelven 20. Es
//                      SMSBus fallando para un paradero válido (~3 % del
//                      catálogo en una muestra de 60)
//   codigo-rechazado · status_code 12, código mal formado de verdad
//   red-inalcanzable · no hubo respuesta (sin conexión, CORS, DNS)
//   timeout          · tardó más de lo que la interfaz puede esperar
//
// Y un principio que el caché hace fácil de romper: una lectura fallida NUNCA
// sobrescribe una buena. Si la API se cae, se sigue mostrando lo último que
// sí supimos, con SU hora y etiquetado como viejo.

/** Estados en los que el paradero es consultable pero hoy no hay dato. */
export const ESTADOS = Object.freeze({
  OK: 'ok',
  SIN_DATOS: 'sin-datos',
  UPSTREAM_CAIDO: 'upstream-caido',
  CODIGO_RECHAZADO: 'codigo-rechazado',
  RED_INALCANZABLE: 'red-inalcanzable',
  TIMEOUT: 'timeout',
  EN_ESPERA: 'en-espera',
});

const MENSAJE = {
  [ESTADOS.SIN_DATOS]: 'Sin buses en camino ahora mismo',
  [ESTADOS.UPSTREAM_CAIDO]: 'El servicio de RED no respondió por este paradero',
  [ESTADOS.CODIGO_RECHAZADO]: 'La API no reconoce este código de paradero',
  [ESTADOS.RED_INALCANZABLE]: 'Sin conexión con la API de RED',
  [ESTADOS.TIMEOUT]: 'La API de RED tardó demasiado',
  [ESTADOS.EN_ESPERA]: 'Esperando turno para consultar',
};

// La API devuelve los textos doblemente codificados ("Horario HÃ¡bil"). Se
// arregla al leer y no al pintar, para que nadie tenga que acordarse.
function arreglarTexto(s) {
  // C2/C3 seguidos de un byte de continuación es la firma del doble encode.
  // Escapes explícitos: con los caracteres literales, cualquier editor que
  // reinterprete el archivo rompe la detección sin dejar rastro.
  if (typeof s !== 'string' || !/[\u00c2-\u00c3][\u0080-\u00bf]/.test(s)) return s || '';
  try {
    const bytes = Uint8Array.from([...s], (c) => c.charCodeAt(0) & 0xff);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

export class BusStopProvider {
  constructor(client) {
    this.client = client;
    this._ultimaBuena = new Map(); // code → lectura con estado ok/sin-datos
  }

  /** Última lectura buena conocida de un paradero (o null). No consulta. */
  ultima(code) { return this._ultimaBuena.get(code) || null; }

  /**
   * Consulta un paradero. Nunca lanza.
   * → { code, state, name, services, buses, fetchedAtWall, message, previa }
   *
   * `fetchedAtWall` es Date.now() y NO el reloj de la simulación: SantiagoClock
   * se puede pausar y acelerar (?t=08:30, ×60), y fechar un dato real con un
   * reloj de mentira es exactamente cómo se fabrica un dato falso creíble.
   */
  async query(code, { signal } = {}) {
    const r = await this.client.query(code, { signal });
    const ahora = Date.now();

    if (!r.ok) {
      const state = ({
        timeout: ESTADOS.TIMEOUT,
        red: ESTADOS.RED_INALCANZABLE,
        http: ESTADOS.UPSTREAM_CAIDO,
        json: ESTADOS.UPSTREAM_CAIDO,
      })[r.reason] || ESTADOS.EN_ESPERA;
      return this._fallo(code, state, ahora, r.reason);
    }

    const j = r.json;
    if (j.status_code === 12) return this._fallo(code, ESTADOS.CODIGO_RECHAZADO, ahora);
    if (j.status_code !== 0) return this._fallo(code, ESTADOS.UPSTREAM_CAIDO, ahora);

    const services = (j.services || []).map((s) => ({
      id: s.id,
      valid: Boolean(s.valid),
      note: arreglarTexto(s.status_description),
      buses: (s.buses || []).map((b) => ({
        plate: b.id,
        meters: Number.isFinite(b.meters_distance) ? b.meters_distance : null,
        minEta: b.min_arrival_time ?? null,
        maxEta: b.max_arrival_time ?? null,
      })),
    }));

    const buses = services.flatMap((s) => s.buses.map((b) => ({ ...b, service: s.id })));
    const lectura = {
      code,
      state: buses.length ? ESTADOS.OK : ESTADOS.SIN_DATOS,
      name: arreglarTexto(j.name) || null,
      services,
      buses,
      fetchedAtWall: ahora,
      message: buses.length ? '' : MENSAJE[ESTADOS.SIN_DATOS],
      previa: null,
    };
    this._ultimaBuena.set(code, lectura);
    return lectura;
  }

  _fallo(code, state, ahora, detalle) {
    // se conserva la última lectura buena CON SU HORA: el panel puede seguir
    // mostrándola como vieja, que es distinto de mostrarla como actual
    return {
      code,
      state,
      name: this._ultimaBuena.get(code)?.name || null,
      services: [],
      buses: [],
      fetchedAtWall: ahora,
      message: MENSAJE[state] || 'No se pudo consultar',
      detalle: detalle || null,
      previa: this._ultimaBuena.get(code) || null,
    };
  }
}

/** ¿La lectura trae buses reales? Útil para no pintar estados como si fueran datos. */
export const hayDatos = (l) => l?.state === ESTADOS.OK && l.buses.length > 0;
