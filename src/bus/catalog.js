// Catálogo de paraderos: decodifica data/bus/stops.json y responde
// "qué paraderos hay cerca de aquí".
//
// El catálogo pesa 64 KB gzip y se carga bajo demanda, no al arrancar: si
// nadie enciende los buses, metrovivo sigue pesando lo que pesaba. Los nombres
// (78 KB) van en otro archivo y se piden aún más tarde — sólo hacen falta
// cuando ya hay un paradero elegido.
//
// Coordenadas: se guardan como deltas enteros a 1e-5 (~1,1 m) sobre una lista
// ordenada por latitud. Esa ordenación no es cosmética: hace que la búsqueda
// por cercanía sea una ventana binaria sobre la latitud en vez de un barrido
// de 12.134 elementos.

const M_PER_DEG_LAT = 110540;

export class StopCatalog {
  constructor(raw, projection) {
    const { lat0, lon0 } = projection;
    this.mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
    this.lat0 = lat0;
    this.lon0 = lon0;

    this.codes = raw.codes.split(',');
    const n = this.codes.length;
    const s = raw.meta.scale;

    this.lat = new Float64Array(n);
    this.lon = new Float64Array(n);
    let aLat = 0, aLon = 0;
    for (let i = 0; i < n; i++) {
      aLat += raw.lat[i]; aLon += raw.lon[i];
      this.lat[i] = aLat / s;
      this.lon[i] = aLon / s;
    }

    // posición en la escena (metros), con la MISMA proyección que el metro
    this.x = new Float64Array(n);
    this.z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = (this.lon[i] - lon0) * this.mPerDegLon;
      this.z[i] = -((this.lat[i] - lat0) * M_PER_DEG_LAT); // z = -norte, como la escena
    }

    this.byCode = new Map();
    for (let i = 0; i < n; i++) this.byCode.set(this.codes[i], i);
    this.names = null; // se rellena con loadNames()
    this.meta = raw.meta;
  }

  get size() { return this.codes.length; }

  index(code) { const i = this.byCode.get(code); return i === undefined ? -1 : i; }
  code(i) { return this.codes[i]; }
  name(i) { return this.names ? this.names[i] : null; }
  position(i) { return { x: this.x[i], z: this.z[i] }; }

  /** Nombres oficiales del GTFS, en el mismo orden que los códigos. */
  loadNames(raw) {
    const arr = raw.names.split('|');
    if (arr.length !== this.codes.length) {
      throw new Error(`names.json descuadrado: ${arr.length} nombres para ${this.codes.length} paraderos`);
    }
    this.names = arr;
  }

  /**
   * Paraderos dentro de un radio (m) de un punto de la escena, del más cercano
   * al más lejano. Aprovecha que la lista va ordenada por latitud: se acota
   * primero la banda de z y sólo dentro de ella se mide.
   */
  near(x, z, radius = 400, limit = 12) {
    const dLat = radius / M_PER_DEG_LAT;
    const latC = this.lat0 - z / M_PER_DEG_LAT; // z = -norte
    const lo = lowerBound(this.lat, latC - dLat);
    const hi = lowerBound(this.lat, latC + dLat);
    const r2 = radius * radius;
    const out = [];
    for (let i = lo; i < hi; i++) {
      const dx = this.x[i] - x, dz = this.z[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= r2) out.push({ i, d: Math.sqrt(d2) });
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, limit);
  }

  /** El más cercano, o null si no hay ninguno dentro del radio. */
  nearest(x, z, radius = 400) {
    const r = this.near(x, z, radius, 1);
    return r.length ? r[0] : null;
  }
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Carga el catálogo. Los import() dinámicos hacen que Vite emita los datos en
 * un chunk aparte: no entran en el bundle inicial.
 */
export async function loadCatalog(projection) {
  const raw = (await import('../../data/bus/stops.json')).default;
  return new StopCatalog(raw, projection);
}

export async function loadNames(catalog) {
  if (catalog.names) return catalog;
  catalog.loadNames((await import('../../data/bus/names.json')).default);
  return catalog;
}
