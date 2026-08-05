#!/usr/bin/env node
// Catálogo de paraderos y trazados de RED, desde el GTFS oficial del DTPM.
//
//   node scripts/build-bus-data.mjs .cache/gtfs/V166.20260704
//
// Salidas en data/bus/:
//   stops.json    · código + lat/lon de los ~12.100 paraderos consultables
//   names.json    · nombre de cada paradero, en el mismo orden (carga diferida)
//   shapes.json   · trazado por (servicio, sentido), polilínea codificada
//   patterns.json · paraderos EN ORDEN por trazado, con su offset de arco (m)
//
// POR QUÉ ESTE ARCHIVO EXISTE
// La API de RED sólo responde si ya conoces el código del paradero, y no
// publica ningún listado: /red/bus-stop/{código} es su único endpoint de
// paraderos. El catálogo sale del GTFS, cuyo `stop_id` ES ese código (medido:
// 98-99 % de los códigos devuelven status_code 0).
//
// Y los trazados son lo que convierte `meters_distance` en una posición: la
// API entrega "este bus está a 614 m del paradero" medidos SOBRE EL RECORRIDO
// (verificado siguiendo 67 patentes: todas decrecen de forma monótona a 6-25
// km/h, velocidad comercial de bus). Con el trazado y el offset de arco del
// paradero, 614 m se convierten en un punto del mapa.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, 'data', 'bus');
const NETWORK = path.join(ROOT, 'data', 'network.json');

// El mismo regex con el que la API valida: los códigos fuera de él los rechaza
// con status_code 12 (andenes PT* de EFE, PBA* del aeropuerto…). Filtrar aquí
// evita ofrecer paraderos que el usuario no podría consultar.
const STOP_CODE = /^[Pp][A-Ja-j][0-9]{1,5}$/;
const BUS_ROUTE_TYPE = '3';
const DP_TOLERANCE = 2;   // m: simplificación de trazados (ver nota al final)
const PRECISION = 1e5;    // 5 decimales ≈ 1,1 m

const log = (...a) => console.log('[bus]', ...a);

const dir = process.argv[2];
if (!dir) {
  console.error('uso: node scripts/build-bus-data.mjs <directorio-gtfs>');
  console.error('     (obtenlo con: node scripts/fetch-gtfs.mjs)');
  process.exit(1);
}

// ── proyección: la misma de la escena, leída de network.json ───────────────
// No se redefine aquí a propósito. Si las dos proyecciones divergieran, los
// paraderos caerían desplazados respecto de las líneas de metro y nada en la
// pantalla lo delataría.
if (!fs.existsSync(NETWORK)) {
  console.error('falta data/network.json — ejecútalo después de scripts/build-data.js');
  process.exit(1);
}
const network = JSON.parse(fs.readFileSync(NETWORK, 'utf8'));
if (network.meta?.source === 'sample') {
  console.error(
    'data/network.json está construido con el dataset de EJEMPLO (meta.source: "sample").\n' +
    'Sus estaciones tienen coordenadas aproximadas (~640 m de desviación mediana), y dibujar\n' +
    'encima paraderos de precisión métrica produce un desalineamiento que el visitante no\n' +
    'puede diagnosticar. Regenera primero:\n' +
    '  node scripts/fetch-gtfs.mjs && node scripts/build-data.js .cache/gtfs/<version>',
  );
  process.exit(1);
}
const { lat0, lon0 } = network.projection;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((lat0 * Math.PI) / 180);
const project = (lon, lat) => [(lon - lon0) * M_PER_DEG_LON, (lat - lat0) * M_PER_DEG_LAT];

// ── lectura ────────────────────────────────────────────────────────────────
const splitLine = (line) => {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(f); f = ''; }
    else f += c;
  }
  out.push(f);
  return out;
};

/** Recorre un CSV grande sin cargarlo entero (stop_times son 51 MB). */
async function stream(file, onRow) {
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(dir, file)),
    crlfDelay: Infinity,
  });
  let cols = null;
  for await (const line of rl) {
    if (!line) continue;
    if (!cols) { cols = splitLine(line.replace(/^﻿/, '')).map((c) => c.trim()); continue; }
    const v = splitLine(line);
    const row = {};
    for (let i = 0; i < cols.length; i++) row[cols[i]] = v[i] ?? '';
    onRow(row);
  }
}

const hhmmToSec = (t) => {
  const [h, m, s] = String(t).split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
};

// ── 1. servicios de bus ────────────────────────────────────────────────────
const routes = new Map();
await stream('routes.txt', (r) => {
  if (r.route_type !== BUS_ROUTE_TYPE) return;
  routes.set(r.route_id, { name: r.route_long_name || '', color: r.route_color || '' });
});
log(`${routes.size} servicios de bus`);

// tipo de día por service_id (L=lun-vie, S=sáb, D/F=dom; LJ/V son del metro)
const dayType = new Map();
await stream('calendar.txt', (c) => {
  const wd = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].some((d) => c[d] === '1');
  if (wd) dayType.set(c.service_id, 'wd');
  else if (c.saturday === '1') dayType.set(c.service_id, 'sa');
  else if (c.sunday === '1') dayType.set(c.service_id, 'su');
});

// ── 2. paraderos consultables ──────────────────────────────────────────────
const stopRows = [];
await stream('stops.txt', (s) => {
  if (!STOP_CODE.test(s.stop_id)) return;
  const lat = +s.stop_lat, lon = +s.stop_lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  // el nombre viene prefijado con el propio código ("PD1641-Parada 7 / (M) Macul")
  // y stop_code está vacío en las 18.442 filas del feed
  const name = s.stop_name.replace(new RegExp(`^${s.stop_id}\\s*-\\s*`, 'i'), '').trim();
  stopRows.push({ id: s.stop_id, name, lat, lon });
});
// ordenar por latitud: los deltas quedan pequeños y el JSON comprime mejor
stopRows.sort((a, b) => a.lat - b.lat || a.lon - b.lon);
const stopIdx = new Map(stopRows.map((s, i) => [s.id, i]));
log(`${stopRows.length} paraderos con código consultable`);

// ── 3. viajes: trazado dominante por (servicio, sentido) ───────────────────
const shapeVotes = new Map();  // route|dir|shape → nº de viajes
const tripInfo = new Map();    // trip_id → {route, dir, shape}
await stream('trips.txt', (t) => {
  if (!routes.has(t.route_id) || !t.shape_id) return;
  const dir = t.direction_id === '1' ? 'R' : 'I';
  const k = `${t.route_id}|${dir}|${t.shape_id}`;
  shapeVotes.set(k, (shapeVotes.get(k) || 0) + 1);
  tripInfo.set(t.trip_id, {
    route: t.route_id, dir, shape: t.shape_id, service: t.service_id,
    // el letrero que el bus lleva puesto: "Recoleta", "(M) Las Rejas". Es el
    // destino tal como lo anuncia RED, no el nombre del último paradero (que
    // es una esquina, "Avenida Lo Blanco / esq. J. Edwards Bello").
    // RED marca los recorridos circulares anteponiendo "©" al letrero (112 de
    // 718 patrones). Se separa en bandera: el símbolo de copyright en un
    // letrero de destino es ruido, y "circular" es la información que lleva.
    dest: (t.trip_headsign || '').replace(/^\s*©\s*/, '').trim(),
    circular: /^\s*©/.test(t.trip_headsign || ''),
  });
});

const dominant = new Map(); // route|dir → {shape, trips}
for (const [k, n] of shapeVotes) {
  const [route, dir, shape] = k.split('|');
  const key = `${route}|${dir}`;
  const cur = dominant.get(key);
  if (!cur || n > cur.trips) dominant.set(key, { shape, trips: n });
}
const neededShapes = new Set([...dominant.values()].map((d) => d.shape));
log(`${dominant.size} pares (servicio, sentido) · ${neededShapes.size} trazados dominantes`);

// viaje representativo de cada trazado dominante
const repTrip = new Map(); // shape_id → trip_id
for (const [tripId, t] of tripInfo) {
  if (!neededShapes.has(t.shape)) continue;
  if (!repTrip.has(t.shape)) repTrip.set(t.shape, tripId);
}
const repTrips = new Set(repTrip.values());

// ── 4. geometría de los trazados ───────────────────────────────────────────
const rawShapes = new Map(); // shape_id → [[seq, lon, lat], …]
await stream('shapes.txt', (p) => {
  if (!neededShapes.has(p.shape_id)) return;
  if (!rawShapes.has(p.shape_id)) rawShapes.set(p.shape_id, []);
  rawShapes.get(p.shape_id).push([+p.shape_pt_sequence, +p.shape_pt_lon, +p.shape_pt_lat]);
});
for (const pts of rawShapes.values()) pts.sort((a, b) => a[0] - b[0]);
log(`${rawShapes.size} trazados leídos`);

// ── 4b. ventanas de frecuencia por viaje ───────────────────────────────────
// Los buses son viajes POR FRECUENCIA: 14.521 ventanas [inicio, fin, headway]
// en frequencies.txt, y sus stop_times son offsets desde 0:00:00. Con ambas
// cosas la posición de cada bus es f(hora), igual que el metro.
const freqByTrip = new Map();
await stream('frequencies.txt', (f) => {
  if (!tripInfo.has(f.trip_id)) return;
  if (!freqByTrip.has(f.trip_id)) freqByTrip.set(f.trip_id, []);
  freqByTrip.get(f.trip_id).push([hhmmToSec(f.start_time), hhmmToSec(f.end_time), +f.headway_secs]);
});
log(`ventanas de frecuencia para ${freqByTrip.size} viajes`);

// ── 5. paraderos en orden (y hora de paso) de cada viaje representativo ────
const tripStops = new Map(); // trip_id → [[seq, stop_id, arrSec], …]
await stream('stop_times.txt', (st) => {
  if (!repTrips.has(st.trip_id)) return;
  if (!tripStops.has(st.trip_id)) tripStops.set(st.trip_id, []);
  tripStops.get(st.trip_id).push([+st.stop_sequence, st.stop_id, hhmmToSec(st.arrival_time || st.departure_time)]);
});
for (const a of tripStops.values()) a.sort((x, y) => x[0] - y[0]);
log(`secuencias leídas para ${tripStops.size} viajes representativos`);

// bandas por (route|dir|día), tomando el service_id DOMINANTE del tipo de día
// para no sumar calendarios paralelos (la lección del metro: LJ+V duplicaba
// las salidas y partía el intervalo a la mitad)
function bandasDe(routeId, dirId) {
  const porServicio = new Map(); // service_id → {n, bands: []}
  for (const [tripId, t] of tripInfo) {
    if (t.route !== routeId || t.dir !== dirId) continue;
    const e = porServicio.get(t.service) || { n: 0, bands: [] };
    e.n++;
    for (const b of freqByTrip.get(tripId) || []) e.bands.push(b);
    porServicio.set(t.service, e);
  }
  const out = { wd: [], sa: [], su: [] };
  for (const k of ['wd', 'sa', 'su']) {
    let best = null;
    for (const [svc, e] of porServicio) {
      if (dayType.get(svc) !== k) continue;
      if (!best || e.n > best.n) best = e;
    }
    if (best) out[k] = best.bands.slice().sort((a, b) => a[0] - b[0]);
  }
  return out;
}

// ── 6. simplificar, encodear y proyectar paraderos sobre el arco ───────────
const shapesOut = {};
const patternsOut = {};
const stats = { patrones: 0, sinTrazado: 0, sinParadas: 0, paradasFuera: 0, paradas: 0 };
let maxDesvio = { m: 0, stop: null };
const sesgos = [];
let peorSesgo = { bias: 0, shape: null };
const puntos = { antes: 0, despues: 0 };
const todosDesvios = [];

for (const [key, { shape }] of dominant) {
  const [routeId, dirId] = key.split('|');
  const rep = tripInfo.get(repTrip.get(shape)); // viaje representativo: su letrero
  const raw = rawShapes.get(shape);
  if (!raw || raw.length < 2) { stats.sinTrazado++; continue; }

  const lonlat = raw.map(([, lon, lat]) => [lon, lat]);
  const kept = simplify(lonlat, DP_TOLERANCE);
  const xy = kept.map(([lon, lat]) => project(lon, lat));
  const cum = cumulative(xy);

  // sesgo de longitud introducido por la simplificación: es el error que
  // descuadra la inversión de meters_distance, y se mide, no se supone
  const cumFull = cumulative(lonlat.map(([lon, lat]) => project(lon, lat)));
  const lenFull = cumFull[cumFull.length - 1];
  if (lenFull > 0) {
    const bias = (cum[cum.length - 1] - lenFull) / lenFull;
    sesgos.push(bias);
    if (Math.abs(bias) > Math.abs(peorSesgo.bias)) peorSesgo = { bias, shape };
  }
  puntos.antes += lonlat.length;
  puntos.despues += kept.length;

  const seq = tripStops.get(repTrip.get(shape)) || [];
  if (!seq.length) { stats.sinParadas++; continue; }

  const st = [], arc = [], sec = []; // arc y sec van en DELTAS acumulables
  let last = -1, lastSec = -1, baseSec = null;
  for (const [, stopId, arrSec] of seq) {
    const idx = stopIdx.get(stopId);
    if (idx === undefined) { stats.paradasFuera++; continue; } // andén EFE, código no consultable
    const s = stopRows[idx];
    const [px, py] = project(s.lon, s.lat);
    const { arc: a, dist } = nearestOnPath(xy, cum, px, py);
    if (dist > maxDesvio.m) maxDesvio = { m: dist, stop: s.id };
    todosDesvios.push(dist);
    const aMono = Math.max(a, last + 1);
    st.push(idx);
    // delta contra el paradero anterior: son distancias entre paraderos
    // (cientos de metros) en vez de arcos absolutos de hasta cinco cifras
    arc.push(Math.round(aMono) - (last < 0 ? 0 : Math.round(last)));
    last = aMono;
    // hora de paso: offset desde la salida (los stop_times de viajes por
    // frecuencia parten de 0:00:00), monótona por construcción del itinerario
    if (baseSec === null) baseSec = arrSec;
    const t = Math.max((arrSec ?? baseSec) - baseSec, lastSec + 1);
    sec.push(t - (lastSec < 0 ? 0 : lastSec));
    lastSec = t;
    stats.paradas++;
  }
  if (st.length < 2) { stats.sinParadas++; continue; }

  shapesOut[shape] = encodePolyline(kept);
  (patternsOut[routeId] ||= {})[dirId] = {
    shape, st, arc, sec,
    len: Math.round(cum[cum.length - 1]),
    freq: bandasDe(routeId, dirId),
    ...(rep?.dest ? { dest: rep.dest } : {}),
    ...(rep?.circular ? { circ: 1 } : {}),
  };
  stats.patrones++;
}

// ── 7. escribir ────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

const enc = (vals) => { // primer valor absoluto, luego deltas enteros
  const out = [];
  let prev = 0;
  for (const v of vals) { const q = Math.round(v * PRECISION); out.push(q - prev); prev = q; }
  return out;
};

const provenance = (() => {
  const p = path.join(ROOT, 'data', '.gtfs-provenance.json');
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { feed_version: j.feed_version, valid_until: j.valid_until };
})();

write('stops.json', {
  meta: { ...provenance, count: stopRows.length, scale: PRECISION },
  codes: stopRows.map((s) => s.id).join(','),
  lon: enc(stopRows.map((s) => s.lon)),
  lat: enc(stopRows.map((s) => s.lat)),
});
write('names.json', {
  meta: { count: stopRows.length },
  // '|' no aparece en ningún nombre del feed (comprobado abajo)
  names: stopRows.map((s) => s.name).join('|'),
});
write('shapes.json', { meta: { ...provenance, count: Object.keys(shapesOut).length, precision: PRECISION }, shapes: shapesOut });
write('patterns.json', {
  meta: { ...provenance, count: stats.patrones },
  routes: Object.fromEntries([...routes].map(([id, r]) => [id, r.name])),
  patterns: patternsOut,
});

const bar = stopRows.find((s) => s.name.includes('|'));
if (bar) console.warn(`⚠ un nombre contiene '|': ${bar.id} "${bar.name}" — el separador de names.json ya no sirve`);

log('');
log(`patrones ${stats.patrones} · paraderos en patrón ${stats.paradas}`);
log(`descartados: ${stats.sinTrazado} sin trazado, ${stats.sinParadas} sin paradas útiles, ${stats.paradasFuera} paradas con código no consultable`);
// Cuánto se aparta un paradero del trazado de su propio servicio. Es el error
// que se hereda al ubicar un bus: si un paradero cae a 200 m de la línea, su
// offset de arco es una aproximación. La MEDIANA es lo que manda; la cola
// larga son paraderos de terminal y de vías segregadas.
todosDesvios.sort((a, b) => a - b);
const q = (p) => todosDesvios[Math.floor(todosDesvios.length * p)] || 0;
log(`desvío paradero↔trazado: mediana ${q(0.5).toFixed(1)} m · p95 ${q(0.95).toFixed(0)} m · p99 ${q(0.99).toFixed(0)} m · máx ${maxDesvio.m.toFixed(0)} m (${maxDesvio.stop})`);
const medio = sesgos.reduce((a, b) => a + b, 0) / (sesgos.length || 1);
log(
  `simplificación DP ${DP_TOLERANCE} m: ${puntos.antes} → ${puntos.despues} puntos ` +
  `(${((100 * puntos.despues) / puntos.antes).toFixed(1)} %)`,
);
log(
  `sesgo de longitud: medio ${(medio * 100).toFixed(3)} %, peor ${(peorSesgo.bias * 100).toFixed(3)} % ` +
  `(${peorSesgo.shape}) → ${Math.abs(peorSesgo.bias * 10000).toFixed(1)} m de error a 10 km`,
);

function write(name, obj) {
  const p = path.join(OUT_DIR, name);
  const json = JSON.stringify(obj);
  fs.writeFileSync(p, json);
  const gz = zlibSize(json);
  log(`✓ data/bus/${name}  ${(json.length / 1024).toFixed(1)} KB  (gzip ${(gz / 1024).toFixed(1)} KB)`);
}

function zlibSize(s) {
  return zlib.gzipSync(Buffer.from(s), { level: 9 }).length;
}

// ── geometría ──────────────────────────────────────────────────────────────
function cumulative(xy) {
  const c = new Float64Array(xy.length);
  for (let i = 1; i < xy.length; i++) {
    c[i] = c[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
  }
  return c;
}

/**
 * Punto más cercano del trazado A PARTIR de un arco mínimo.
 *
 * El `minArc` no es una optimización: muchos recorridos vuelven a pasar por la
 * misma calle (lazos de terminal, ida y vuelta por la misma avenida), y una
 * búsqueda global engancha el paradero en la pasada equivocada. El síntoma no
 * es un error pequeño sino un salto de kilómetros, y no se ve en el mapa:
 * el bus aparece en un punto perfectamente creíble del recorrido correcto.
 * Buscando sólo hacia adelante desde el paradero anterior, el orden del
 * stop_times decide la pasada.
 */
function nearestOnPath(xy, cum, px, py, minArc = 0) {
  let bestArc = 0, bestD2 = Infinity;
  let desde = 1;
  if (minArc > 0) {
    // primer segmento que termina más allá del arco mínimo
    while (desde < xy.length - 1 && cum[desde] < minArc) desde++;
  }
  for (let i = desde; i < xy.length; i++) {
    const ax = xy[i - 1][0], ay = xy[i - 1][1];
    const dx = xy[i][0] - ax, dy = xy[i][1] - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t, qy = ay + dy * t;
    const d2 = (px - qx) ** 2 + (py - qy) ** 2;
    if (d2 < bestD2) { bestD2 = d2; bestArc = cum[i - 1] + Math.sqrt(len2) * t; }
  }
  return { arc: bestArc, dist: Math.sqrt(bestD2) };
}

/**
 * Douglas-Peucker sobre coordenadas proyectadas (tolerancia en metros), pero
 * devolviendo los lon/lat originales de los puntos conservados.
 *
 * La tolerancia importa por el SESGO DE LONGITUD, no por el error
 * perpendicular: recortar vértices acorta el trazado y descuadra la inversión
 * de meters_distance. A 8 m el sesgo queda en torno al 0,2 %, bastante por
 * debajo del error del propio dato (~25 m); el resumen real se imprime al
 * final del build.
 */
function simplify(lonlat, tol) {
  const n = lonlat.length;
  if (n < 3) return lonlat.slice();
  const xy = lonlat.map(([lon, lat]) => project(lon, lat));
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = xy[a][0], ay = xy[a][1];
    const dx = xy[b][0] - ax, dy = xy[b][1] - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let far = -1, farD = tol;
    for (let i = a + 1; i < b; i++) {
      let t = ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(xy[i][0] - (ax + dx * t), xy[i][1] - (ay + dy * t));
      if (d > farD) { farD = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(lonlat[i]);
  return out;
}

/** Polilínea codificada de Google, precisión 1e5, en orden [lat, lon]. */
function encodePolyline(lonlat) {
  let out = '', prevLat = 0, prevLon = 0;
  for (const [lon, lat] of lonlat) {
    const qLat = Math.round(lat * PRECISION), qLon = Math.round(lon * PRECISION);
    out += chunk(qLat - prevLat) + chunk(qLon - prevLon);
    prevLat = qLat; prevLon = qLon;
  }
  return out;
}
function chunk(v) {
  let x = v < 0 ? ~(v << 1) : v << 1;
  let s = '';
  while (x >= 0x20) { s += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>= 5; }
  return s + String.fromCharCode(x + 63);
}
