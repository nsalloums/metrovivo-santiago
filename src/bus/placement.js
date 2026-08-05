// De "este bus está a 614 m del paradero PA1 en el servicio J01" a un punto
// de la escena.
//
// Función PURA: sin red, sin DOM, sin three.js. Es el análogo de src/sim.js,
// que es testeable justamente porque no toca nada. Aquí vive además la parte
// más delicada del proyecto: decidir cuándo NO se puede ubicar un bus.
//
// CÓMO FUNCIONA
// meters_distance es distancia SOBRE EL RECORRIDO hasta el paradero (medido:
// 67 patentes seguidas 12 min, todas monótonas decrecientes a 6-25 km/h; y la
// misma patente vista desde dos paraderos da exactamente la separación entre
// ellos: PA1→PA2 = 780 m para los servicios 426, 422, 507, B26 y 513 por
// igual). Así que si el paradero está en el arco A del trazado, el bus está
// en A − 614.
//
// LAS ABSTENCIONES NO SON RAMAS VACÍAS
// Cada una es un caso en que ubicar el bus produciría un punto plausible y
// equivocado, que es peor que no dibujar nada. Ninguna se rellena "por si
// acaso": si no se sabe, se dice.

export const MOTIVOS = Object.freeze({
  SERVICIO_DESCONOCIDO: 'servicio-desconocido',
  PARADERO_FUERA: 'paradero-fuera-del-recorrido',
  SENTIDO_AMBIGUO: 'sentido-ambiguo',
  ANTES_DEL_INICIO: 'antes-del-inicio',
  DISPERSION: 'observaciones-incoherentes',
  SIN_METROS: 'sin-distancia',
});

export const EXPLICACION = {
  [MOTIVOS.SERVICIO_DESCONOCIDO]: 'Este servicio no está en el GTFS vigente',
  [MOTIVOS.PARADERO_FUERA]: 'El paradero no figura en el recorrido de este servicio',
  [MOTIVOS.SENTIDO_AMBIGUO]: 'El paradero sirve los dos sentidos: no se puede saber cuál lleva',
  [MOTIVOS.ANTES_DEL_INICIO]: 'El bus va por una variante del recorrido que no tenemos',
  [MOTIVOS.DISPERSION]: 'Los paraderos no coinciden en dónde está',
  [MOTIVOS.SIN_METROS]: 'La API no entregó la distancia de este bus',
};

// Velocidad máxima creíble de un bus urbano para acotar la banda de
// incertidumbre. Medido sobre 67 patentes: mediana 13,9 km/h, máximo 39 km/h.
// 50 km/h deja margen sin volver la banda absurda.
const V_MAX_MS = 50 / 3.6;
// El backend refresca cada ~33 s (mediana medida, p90 34 s): incluso una
// lectura recién traída puede ser de hace medio minuto.
export const EDAD_BASE_MS = 33000;

const M_PER_DEG_LAT = 110540;

export class BusPlacer {
  /**
   * @param patterns  data/bus/patterns.json
   * @param shapes    data/bus/shapes.json
   * @param catalog   StopCatalog (para índices de paradero)
   * @param projection {lat0, lon0} de data/network.json
   */
  constructor(patterns, shapes, catalog, projection) {
    this.patterns = patterns.patterns;
    this.routeNames = patterns.routes || {};
    this.rawShapes = shapes.shapes;
    this.catalog = catalog;
    this.lat0 = projection.lat0;
    this.lon0 = projection.lon0;
    this.mPerDegLon = 111320 * Math.cos((projection.lat0 * Math.PI) / 180);
    this._decoded = new Map(); // shapeId → {x, z, cum}
    this._arcs = new Map();    // routeId|dir → Float64Array de arcos absolutos
  }

  conoce(service) { return Boolean(this.patterns[service]); }
  nombreServicio(service) { return this.routeNames[service] || ''; }

  /**
   * Sentido de un (paradero, servicio). La API no lo entrega, pero el par lo
   * determina: un paradero concreto sólo sirve una dirección del recorrido en
   * el 99,5 % de los casos. Cuando sirve las dos, se abstiene.
   * → 'I' | 'R' | null
   */
  sentido(service, stopIdx) {
    const p = this.patterns[service];
    if (!p) return null;
    const enI = p.I && p.I.st.includes(stopIdx);
    const enR = p.R && p.R.st.includes(stopIdx);
    if (enI && enR) return null; // ambiguo
    if (enI) return 'I';
    if (enR) return 'R';
    return null;
  }

  /** Arcos absolutos (m) de los paraderos de un patrón; se acumulan una vez. */
  arcos(service, dir) {
    const k = `${service}|${dir}`;
    let a = this._arcs.get(k);
    if (a) return a;
    const p = this.patterns[service]?.[dir];
    if (!p) return null;
    a = new Float64Array(p.arc.length);
    let acc = 0;
    for (let i = 0; i < p.arc.length; i++) { acc += p.arc[i]; a[i] = acc; }
    this._arcs.set(k, a);
    return a;
  }

  /** Trazado decodificado y proyectado a la escena, con arcos acumulados. */
  trazado(shapeId) {
    let t = this._decoded.get(shapeId);
    if (t) return t;
    const enc = this.rawShapes[shapeId];
    if (!enc) return null;
    const pts = decodePolyline(enc);
    const n = pts.length;
    const x = new Float64Array(n), z = new Float64Array(n), cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = (pts[i][1] - this.lon0) * this.mPerDegLon;
      z[i] = -((pts[i][0] - this.lat0) * M_PER_DEG_LAT);
      if (i) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
    }
    t = { x, z, cum, len: cum[n - 1] };
    this._decoded.set(shapeId, t);
    return t;
  }

  /**
   * Ubica un bus a partir de una o varias observaciones de la MISMA patente.
   * observations: [{ stopCode, service, meters }]
   *
   * → { ok:true, service, dir, shapeId, s, x, z, heading, spread, n }
   * → { ok:false, motivo, explicacion }
   */
  locate(observations) {
    const obs = observations.filter((o) => Number.isFinite(o.meters));
    if (!obs.length) return no(MOTIVOS.SIN_METROS);

    const service = obs[0].service;
    if (!this.patterns[service]) return no(MOTIVOS.SERVICIO_DESCONOCIDO);

    // cada observación propone un arco s = arco(paradero) − metros
    const propuestas = [];
    let dir = null, ambiguo = false, fuera = 0;
    for (const o of obs) {
      const idx = this.catalog.index(o.stopCode);
      if (idx < 0) { fuera++; continue; }
      const d = this.sentido(o.service, idx);
      if (!d) {
        // distinguir "sirve los dos sentidos" de "no está en el recorrido"
        const p = this.patterns[o.service];
        if (p?.I?.st.includes(idx) || p?.R?.st.includes(idx)) ambiguo = true;
        else fuera++;
        continue;
      }
      if (dir && d !== dir) { ambiguo = true; continue; }
      dir = d;
      const arcs = this.arcos(o.service, d);
      const pos = this.patterns[o.service][d].st.indexOf(idx);
      if (pos < 0) { fuera++; continue; }
      propuestas.push(arcs[pos] - o.meters);
    }

    if (!propuestas.length) return no(ambiguo ? MOTIVOS.SENTIDO_AMBIGUO : MOTIVOS.PARADERO_FUERA);

    // Dispersión: si dos paraderos del mismo recorrido no coinciden en dónde
    // está el bus, es que va por una variante que no es la dominante. Un
    // promedio taparía el problema y colocaría el bus en un punto en el que
    // ninguna observación lo sitúa.
    const s = mediana(propuestas);
    const spread = propuestas.length > 1 ? Math.max(...propuestas) - Math.min(...propuestas) : 0;
    if (spread > 250) return no(MOTIVOS.DISPERSION, { spread });

    // s < 0: el bus está "antes" del inicio del trazado que conocemos, o sea
    // que su recorrido real es más largo que la variante dominante.
    if (s < 0) return no(MOTIVOS.ANTES_DEL_INICIO, { s });

    const shapeId = this.patterns[service][dir].shape;
    const t = this.trazado(shapeId);
    if (!t) return no(MOTIVOS.SERVICIO_DESCONOCIDO);

    const p = puntoEnArco(t, s);
    return {
      ok: true,
      service, dir, shapeId,
      s, spread, n: propuestas.length, fuera,
      x: p.x, z: p.z, heading: p.heading,
      largo: t.len,
    };
  }

  /**
   * Cuánto puede haber avanzado el bus desde que se midió. La incertidumbre
   * dominante no es geométrica (el desvío paradero↔trazado tiene mediana de
   * 5 m) sino TEMPORAL: la lectura ya nace con ~33 s encima.
   * → { desde, hasta } en metros de arco. El bus está en algún punto de ahí.
   */
  banda(s, edadMs) {
    const edad = Math.max(0, edadMs) + EDAD_BASE_MS;
    return { desde: s, hasta: s + (edad / 1000) * V_MAX_MS };
  }

  /** Punto de la escena a un arco dado (para dibujar la banda o mover la cámara). */
  puntoEn(shapeId, s) {
    const t = this.trazado(shapeId);
    return t ? puntoEnArco(t, s) : null;
  }
}

function no(motivo, extra = {}) {
  return { ok: false, motivo, explicacion: EXPLICACION[motivo], ...extra };
}

function mediana(xs) {
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function puntoEnArco(t, s) {
  const { x, z, cum } = t;
  const n = cum.length;
  const sc = Math.max(0, Math.min(cum[n - 1], s));
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < sc) lo = mid + 1; else hi = mid;
  }
  const i = Math.max(1, lo);
  const seg = cum[i] - cum[i - 1] || 1e-9;
  const f = (sc - cum[i - 1]) / seg;
  const px = x[i - 1] + (x[i] - x[i - 1]) * f;
  const pz = z[i - 1] + (z[i] - z[i - 1]) * f;
  return { x: px, z: pz, heading: Math.atan2(-(z[i] - z[i - 1]), x[i] - x[i - 1]) };
}

/** Polilínea codificada de Google (precisión 1e5) → [[lat, lon], …]. */
export function decodePolyline(str) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    let r = 0, sh = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
    lat += (r & 1) ? ~(r >> 1) : (r >> 1);
    r = 0; sh = 0;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
    lon += (r & 1) ? ~(r >> 1) : (r >> 1);
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}
