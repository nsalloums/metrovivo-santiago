#!/usr/bin/env node
// Preprocesamiento de datos para metrovivo.
//
// Uso:
//   node scripts/build-data.js                → usa el dataset de ejemplo embebido
//   node scripts/build-data.js ruta/gtfs-dir  → procesa un GTFS descomprimido
//                                               (routes/trips/stop_times/stops/
//                                                shapes/frequencies/calendar),
//                                               filtrando route_type = 1 (metro)
//
// Salida: data/network.json — líneas con curvas muestreadas (posición
// geográfica Y esquemática con parametrización compatible para el morph),
// estaciones con ambas posiciones, frecuencias por franja horaria y contexto
// (río Mapocho).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIONS, LINES, RIVER } from './sample-data.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'data', 'network.json');
const EXPRESS_CFG = path.join(ROOT, 'express-config.json');

const SAMPLES_PER_SEG = 16; // muestras de curva entre estaciones consecutivas

// ── Proyección: plano local equirectangular centrado en Santiago (metros) ──
const LAT0 = -33.45, LON0 = -70.66;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const project = ([lon, lat]) => [(lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT];

// ── Utilidades geométricas ─────────────────────────────────────────────────
function catmullRom(points, samplesPerSeg = SAMPLES_PER_SEG, alpha = 0.5) {
  // Catmull-Rom centrípeta a través de todos los puntos. Devuelve
  // samplesPerSeg*(n-1)+1 puntos; el punto i*samplesPerSeg coincide con el nodo i.
  const n = points.length;
  if (n < 2) return points.slice();
  const out = [];
  const get = (i) => points[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const dt = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), alpha) || 1e-6;
    const t0 = 0, t1 = t0 + dt(p0, p1), t2 = t1 + dt(p1, p2), t3 = t2 + dt(p2, p3);
    for (let j = 0; j < samplesPerSeg; j++) {
      const t = t1 + ((t2 - t1) * j) / samplesPerSeg;
      out.push(interpCR(p0, p1, p2, p3, t0, t1, t2, t3, t));
    }
  }
  out.push([...points[n - 1]]);
  return out;
}

function interpCR(p0, p1, p2, p3, t0, t1, t2, t3, t) {
  const lerpP = (a, b, ta, tb) => {
    if (tb - ta < 1e-9) return a;
    const s = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
  };
  const a1 = lerpP(p0, p1, t0, t1), a2 = lerpP(p1, p2, t1, t2), a3 = lerpP(p2, p3, t2, t3);
  const b1 = lerpP(a1, a2, t0, t2), b2 = lerpP(a2, a3, t1, t3);
  return lerpP(b1, b2, t1, t2);
}

function cumLengths(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return cum;
}

function pointAtArc(pts, cum, s) {
  const total = cum[cum.length - 1];
  s = Math.max(0, Math.min(total, s));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < s) lo = mid + 1; else hi = mid;
  }
  const i = Math.max(1, lo);
  const seg = cum[i] - cum[i - 1] || 1e-9;
  const f = (s - cum[i - 1]) / seg;
  return [
    pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
    pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f,
  ];
}

const round1 = (v) => Math.round(v * 10) / 10;
const round6 = (v) => Math.round(v * 1e6) / 1e6; // ~0.1 m: suficiente para auditar la proyección

// ── Layout esquemático ─────────────────────────────────────────────────────
// Resuelve la spec (pins/vias/estaciones flotantes) a: coordenada esquemática
// por estación + polilínea completa del trazado de la línea.
function resolveSchematic(spec) {
  const stationIds = [];
  const entries = []; // {kind:'st'|'via', id?, at?}
  for (const e of spec) {
    if (typeof e === 'string') { entries.push({ kind: 'st', id: e }); stationIds.push(e); }
    else if (e.pin) { entries.push({ kind: 'st', id: e.pin, at: e.at }); stationIds.push(e.pin); }
    else entries.push({ kind: 'via', at: e.via });
  }
  const first = entries[0], last = entries[entries.length - 1];
  if (!first.at || !last.at) throw new Error('la spec esquemática debe empezar y terminar con pin');

  const coords = new Map(); // stationId → [x,y]
  const polyline = [];
  let i = 0;
  while (i < entries.length - 1) {
    // tramo entre el pin i y el siguiente pin
    const pinA = entries[i];
    let j = i + 1;
    const floaters = [], vias = [];
    while (j < entries.length && !(entries[j].kind === 'st' && entries[j].at)) {
      if (entries[j].kind === 'st') floaters.push(entries[j]);
      else vias.push(entries[j].at);
      j++;
    }
    const pinB = entries[j];
    const segPts = [pinA.at, ...vias, pinB.at];
    const segCum = cumLengths(segPts);
    const L = segCum[segCum.length - 1];
    floaters.forEach((st, k) => {
      const s = (L * (k + 1)) / (floaters.length + 1);
      coords.set(st.id, pointAtArc(segPts, segCum, s));
    });
    coords.set(pinA.id, pinA.at);
    coords.set(pinB.id, pinB.at);
    // acumular polilínea (sin duplicar el punto de unión)
    const startIdx = polyline.length ? 1 : 0;
    segPts.slice(startIdx === 0 ? 0 : 1).forEach((p) => polyline.push(p));
    if (polyline.length === segPts.length && startIdx === 0) { /* primer tramo ya copiado */ }
    i = j;
  }
  return { stationIds, coords, polyline };
}

// Muestrea el trazado esquemático con la MISMA parametrización que la curva
// geográfica (SAMPLES_PER_SEG entre estaciones), para que el morph interpole
// vértice a vértice sin deslizar las estaciones.
function sampleSchemPath(polyline, stationCoordsInOrder) {
  const cum = cumLengths(polyline);
  // posición de arco de cada estación sobre la polilínea (búsqueda del punto más cercano)
  const stationArcs = stationCoordsInOrder.map((c) => nearestArc(polyline, cum, c));
  // forzar monotonía por seguridad numérica
  for (let i = 1; i < stationArcs.length; i++) {
    if (stationArcs[i] < stationArcs[i - 1]) stationArcs[i] = stationArcs[i - 1];
  }
  const out = [];
  for (let i = 0; i < stationArcs.length - 1; i++) {
    for (let j = 0; j < SAMPLES_PER_SEG; j++) {
      const s = stationArcs[i] + ((stationArcs[i + 1] - stationArcs[i]) * j) / SAMPLES_PER_SEG;
      out.push(pointAtArc(polyline, cum, s));
    }
  }
  out.push(pointAtArc(polyline, cum, stationArcs[stationArcs.length - 1]));
  return out;
}

function nearestArc(pts, cum, c) {
  let best = 0, bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1];
    const bx = pts[i][0], by = pts[i][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((c[0] - ax) * dx + (c[1] - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, py = ay + dy * t;
    const d = (c[0] - px) ** 2 + (c[1] - py) ** 2;
    if (d < bestD) { bestD = d; best = cum[i - 1] + Math.sqrt(len2) * t; }
  }
  return best;
}

// ── Operación expresa (Ruta Roja/Verde) ────────────────────────────────────
// Regla: si el GTFS trae variantes (patrones de parada distintos por línea/
// sentido o headsigns Roja/Verde), se derivan de él; si no, se usa la config
// manual express-config.json (aproximación documentada).
function loadExpressConfig() {
  if (!fs.existsSync(EXPRESS_CFG)) return null;
  return JSON.parse(fs.readFileSync(EXPRESS_CFG, 'utf8'));
}

function expressFromConfig(cfg, lineId, stationIds) {
  const classes = cfg?.lines?.[lineId];
  if (!classes) return undefined;
  const cls = {};
  for (const id of stationIds) {
    let c = classes[id];
    if (!c) { console.warn(`⚠ express ${lineId}: ${id} sin clase en config, se asume C`); c = 'C'; }
    cls[id] = c;
  }
  // terminales siempre comunes
  cls[stationIds[0]] = 'C';
  cls[stationIds[stationIds.length - 1]] = 'C';
  return {
    source: 'config',
    windows: cfg.windows,
    class: cls,
    patterns: {
      R: stationIds.filter((id) => cls[id] !== 'V'),
      V: stationIds.filter((id) => cls[id] !== 'R'),
    },
  };
}

// ── Construcción desde el dataset de ejemplo ───────────────────────────────
function buildFromSample() {
  const expressCfg = loadExpressConfig();
  const lines = LINES.map((l) => {
    const parts = resolveSchematic(l.schematic);
    return {
      id: l.id,
      name: l.name,
      color: l.color,
      freq: l.freq,
      service: l.service,
      express: expressFromConfig(expressCfg, l.id, parts.stationIds),
      ...parts,
    };
  });
  const stations = {};
  for (const l of lines) {
    for (const id of l.stationIds) {
      if (!STATIONS[id]) throw new Error(`estación desconocida en ${l.id}: ${id}`);
      if (!stations[id]) stations[id] = { name: STATIONS[id].name, lines: [], geo: project(STATIONS[id].ll), ll: STATIONS[id].ll };
      stations[id].lines.push(l.id);
    }
  }
  return assemble(lines, stations, 'sample');
}

// ── Ensamblado común: curvas, morph y normalización ────────────────────────
function assemble(lines, stations, source, extra = {}) {
  // bbox geográfico
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of Object.values(stations)) {
    minX = Math.min(minX, s.geo[0]); maxX = Math.max(maxX, s.geo[0]);
    minY = Math.min(minY, s.geo[1]); maxY = Math.max(maxY, s.geo[1]);
  }

  // bbox esquemático (en unidades de grilla) → escalar/centrar al bbox geográfico
  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  for (const l of lines) {
    for (const p of l.polyline) {
      sMinX = Math.min(sMinX, p[0]); sMaxX = Math.max(sMaxX, p[0]);
      sMinY = Math.min(sMinY, p[1]); sMaxY = Math.max(sMaxY, p[1]);
    }
  }
  const scale = Math.min((maxX - minX) / (sMaxX - sMinX || 1), (maxY - minY) / (sMaxY - sMinY || 1));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const scx = (sMinX + sMaxX) / 2, scy = (sMinY + sMaxY) / 2;
  const toGeoSpace = ([x, y]) => [cx + (x - scx) * scale, cy + (y - scy) * scale];

  const outLines = lines.map((l) => {
    const geoStations = l.stationIds.map((id) => stations[id].geo);
    const path = l.geoPath || catmullRom(geoStations);
    const cum = cumLengths(path);
    const stationS = l.geoStationS || l.stationIds.map((_, i) => cum[i * SAMPLES_PER_SEG]);

    const schemStations = l.stationIds.map((id) => l.coords.get(id));
    const schemPathGrid = sampleSchemPath(l.polyline, schemStations);
    const schemPath = schemPathGrid.map(toGeoSpace);
    const schemCum = cumLengths(schemPath);
    const schemStationS = l.stationIds.map((_, i) => schemCum[i * SAMPLES_PER_SEG]);

    // guardar posición esquemática por estación (compartida entre líneas: la
    // spec pinea las combinaciones a la misma coordenada)
    l.stationIds.forEach((id, i) => {
      stations[id].schem = [round1(schemPath[i * SAMPLES_PER_SEG][0]), round1(schemPath[i * SAMPLES_PER_SEG][1])];
    });

    return {
      id: l.id, name: l.name, color: l.color,
      stations: l.stationIds,
      path: path.map((p) => [round1(p[0]), round1(p[1])]),
      stationS: stationS.map(round1),
      schemPath: schemPath.map((p) => [round1(p[0]), round1(p[1])]),
      schemStationS: schemStationS.map(round1),
      freq: l.freq, service: l.service,
      ...(l.express ? { express: l.express } : {}),
    };
  });

  const outStations = {};
  for (const [id, s] of Object.entries(stations)) {
    outStations[id] = {
      name: s.name, lines: s.lines,
      ...(extra.interiors?.[id] ? { in: extra.interiors[id] } : {}),
      // ll = [lon, lat] de origen. Va en el JSON para que la escena sea
      // auditable contra su propia fuente (tests/units.test.js) y para poder
      // cruzarla con datos externos —paraderos de bus— sin depender del
      // dataset de ejemplo, cuyas coordenadas se desvían ~640 m de mediana.
      ll: [round6(s.ll[0]), round6(s.ll[1])],
      geo: [round1(s.geo[0]), round1(s.geo[1])],
      schem: s.schem || [round1(s.geo[0]), round1(s.geo[1])],
    };
  }

  const river = catmullRom(RIVER.map(project), 8).map((p) => [round1(p[0]), round1(p[1])]);

  return {
    meta: { source, generated: new Date().toISOString(), samplesPerSeg: SAMPLES_PER_SEG },
    projection: { lat0: LAT0, lon0: LON0 },
    bbox: [round1(minX), round1(minY), round1(maxX), round1(maxY)],
    ...(extra.calendar ? { calendar: extra.calendar } : {}),
    lines: outLines,
    stations: outStations,
    river,
  };
}

// ── Calendario: feriados y vigencia del feed ───────────────────────────────
//
// El tipo de día NO se puede deducir del día de la semana. calendar_dates.txt
// dice qué días el servicio cambia: el 18 de septiembre cae viernes y opera
// con horario de domingo. Sin esta tabla, ocho días al año la simulación
// muestra frecuencias de día hábil sobre una red que va en horario festivo.
//
// feed_info.txt aporta la otra mitad: hasta cuándo valen estos horarios. Un
// feed vencido sigue dibujando trenes perfectamente creíbles, y ese es
// justamente el fallo que este proyecto no se permite callar.
function buildCalendar(read, has, dayType) {
  const cal = { holidays: {} };

  if (has('feed_info.txt')) {
    const fi = read('feed_info.txt')[0] || {};
    if (fi.feed_version) cal.version = fi.feed_version;
    if (fi.feed_start_date) cal.start = fi.feed_start_date;
    if (fi.feed_end_date) cal.end = fi.feed_end_date;
    if (fi.feed_publisher_name) cal.publisher = fi.feed_publisher_name;
  }

  if (has('calendar_dates.txt')) {
    const añadidos = new Map(); // fecha → [service_id] que se AGREGAN ese día
    for (const e of read('calendar_dates.txt')) {
      if (e.exception_type !== '1') continue; // 2 = se quita; el tipo lo fija lo que se agrega
      if (!añadidos.has(e.date)) añadidos.set(e.date, []);
      añadidos.get(e.date).push(e.service_id);
    }
    for (const [fecha, svcs] of añadidos) {
      // varios service_id pueden agregarse el mismo día (D y F son ambos
      // domingo): se toma el tipo dominante, y si no hay acuerdo se descarta
      const cuenta = new Map();
      for (const s of svcs) {
        const t = dayType.get(s);
        if (t) cuenta.set(t, (cuenta.get(t) || 0) + 1);
      }
      const orden = [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
      if (orden.length && (orden.length === 1 || orden[0][1] > orden[1][1])) {
        cal.holidays[fecha] = orden[0][0];
      }
    }
  }
  return cal;
}

// ── Interior de las estaciones: pathways.txt + levels.txt ─────────────────
//
// pathways.txt es el grafo caminable de cada estación: 7.388 tramos con su
// tiempo de recorrido declarado. Con él, "cuánto se tarda en combinar de L1 a
// L2" deja de ser una suposición y pasa a ser un dato del feed oficial.
//
// EL PUENTE QUE NO ES OBVIO
// Los andenes que usan los stop_times (LH_L1_V1) NO son nodos del grafo; los
// nodos son zonas y equipos (LH:ZP_04, LH:ESC01_BOT). La unión la hace el
// propio GTFS: las ZONAS DE EMBARQUE (location_type=4) cuelgan del andén como
// parent_station y sí son nodos. Andén → sus zonas de embarque → grafo. Sin
// esa cadena hay que inventarse una arista, y aquí no se inventa ninguna:
// los 286 andenes de metro tienen zona de embarque.
const PASO_MS = 1.2;                                  // m/s de un paso normal
const SIN_ESCALONES = new Set(['1', '3', '5', '6', '7']); // ni escalera ni mecánica

function buildInteriors(read, has, stops, stopTimes, trips, lineaDeRuta) {
  if (!has('pathways.txt')) return {};

  const niveles = new Map();
  if (has('levels.txt')) {
    for (const l of read('levels.txt')) niveles.set(l.level_id, { idx: +l.level_index, name: l.level_name });
  }

  // andén (el stop_id de los stop_times) → líneas que lo sirven
  const rutaDe = new Map(trips.map((t) => [t.trip_id, t.route_id]));
  const lineasDe = new Map();
  for (const st of stopTimes) {
    const lid = lineaDeRuta.get(rutaDe.get(st.trip_id));
    if (!lid) continue;
    if (!lineasDe.has(st.stop_id)) lineasDe.set(st.stop_id, new Set());
    lineasDe.get(st.stop_id).add(lid);
  }

  // zonas de embarque por andén, accesos por estación, y todos los niveles
  const zonas = new Map(), accesos = new Map(), nivelesDe = new Map();
  for (const s of stops.values()) {
    if (!s.parent_station) continue;
    if (s.location_type === '4') push(zonas, s.parent_station, s.stop_id);
    else if (s.location_type === '2') push(accesos, s.parent_station, s);
    // los nodos internos cuelgan de la estación: sus niveles son los de ella
    if (s.level_id && niveles.has(s.level_id)) {
      if (!nivelesDe.has(s.parent_station)) nivelesDe.set(s.parent_station, new Set());
      nivelesDe.get(s.parent_station).add(niveles.get(s.level_id).idx);
    }
  }

  // grafo caminable
  const g = new Map();
  let derivados = 0, aBulto = 0;
  const arista = (a, b, tt, modo) => {
    if (!g.has(a)) g.set(a, []);
    g.get(a).push([b, tt, modo]);
  };
  for (const p of read('pathways.txt')) {
    let tt = p.traversal_time ? +p.traversal_time : NaN;
    if (!Number.isFinite(tt)) {
      // sin tiempo declarado: se deriva de la longitud, y si tampoco hay, se
      // asume un tramo corto. Ambos casos se cuentan y se informan.
      if (p.length) { tt = Math.max(1, Math.round(+p.length / PASO_MS)); derivados++; }
      else { tt = 30; aBulto++; }
    }
    arista(p.from_stop_id, p.to_stop_id, tt, p.pathway_mode);
    if (p.is_bidirectional === '1') arista(p.to_stop_id, p.from_stop_id, tt, p.pathway_mode);
  }

  // andenes agrupados por estación
  const porEstacion = new Map();
  for (const [anden, ls] of lineasDe) {
    const s = stops.get(anden);
    if (!s?.parent_station) continue;
    push(porEstacion, s.parent_station, { anden, lineas: [...ls], level: s.level_id });
  }

  const out = {};
  const stats = { estaciones: 0, combinaciones: 0, sinCamino: [], derivados, aBulto };
  for (const [padre, andenes] of porEstacion) {
    const est = stops.get(padre);
    if (!est) continue;
    const id = stationId(est.stop_name);

    // profundidad del andén de cada línea (nivel 0 = calle)
    const prof = {};
    for (const a of andenes) {
      const n = niveles.get(a.level);
      if (!n) continue;
      for (const l of a.lineas) prof[l] = prof[l] === undefined ? n.idx : Math.min(prof[l], n.idx);
    }

    // Andenes alcanzables sin escalones desde ALGÚN acceso de calle. "Algún"
    // no es un descuido: de los 298 accesos de la red solo 166 son accesibles,
    // así que la estación puede ser practicable por una boca y no por la de al
    // lado. Por eso se publican las dos cifras y no una etiqueta binaria.
    const puertas = accesos.get(padre) || [];
    const ids = puertas.map((p) => p.stop_id);
    let sinEsc = 0;
    for (const a of andenes) {
      const z = zonas.get(a.anden) || [];
      if (z.length && ids.length && dijkstra(g, ids, new Set(z), SIN_ESCALONES).sec !== null) sinEsc++;
    }

    const info = {
      prof,
      accesos: puertas.length,
      accesosSF: puertas.filter((p) => p.wheelchair_boarding === '1').length,
      andenes: andenes.length,
      sinEscalones: sinEsc,
      niveles: (nivelesDe.get(padre) || new Set()).size,
    };

    // combinaciones: tiempo real de andén a andén entre cada par de líneas
    const lineas = [...new Set(andenes.flatMap((a) => a.lineas))].sort();
    if (lineas.length > 1) {
      info.comb = {};
      for (let i = 0; i < lineas.length; i++) {
        for (let j = i + 1; j < lineas.length; j++) {
          const A = andenes.filter((a) => a.lineas.includes(lineas[i])).flatMap((a) => zonas.get(a.anden) || []);
          const B = new Set(andenes.filter((a) => a.lineas.includes(lineas[j])).flatMap((a) => zonas.get(a.anden) || []));
          if (!A.length || !B.size) continue;
          const r = dijkstra(g, A, B);
          if (r.sec === null) { stats.sinCamino.push(`${est.stop_name} ${lineas[i]}→${lineas[j]}`); continue; }
          const sf = dijkstra(g, A, B, SIN_ESCALONES);
          info.comb[`${lineas[i]}|${lineas[j]}`] = {
            s: r.sec,
            esc: r.modos['2'] || 0,   // escaleras fijas
            mec: r.modos['4'] || 0,   // escaleras mecánicas
            asc: r.modos['5'] || 0,   // ascensores
            ...(sf.sec !== null ? { sf: sf.sec } : {}), // sin escalones, si existe
          };
          stats.combinaciones++;
        }
      }
    }
    out[id] = info;
    stats.estaciones++;
  }

  console.log(`  interiores: ${stats.estaciones} estaciones · ${stats.combinaciones} combinaciones medidas`);
  if (stats.sinCamino.length) console.warn(`  ⚠ sin camino en pathways: ${stats.sinCamino.join(', ')}`);
  if (derivados || aBulto) {
    console.log(`  tiempos de tramo: ${derivados} derivados de la longitud, ${aBulto} sin longitud ni tiempo`);
  }
  return out;
}

function push(map, k, v) {
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(v);
}

/**
 * Dijkstra desde varios orígenes hasta el primer destino, contando por qué
 * modos pasó el camino elegido. `permitido` limita los pathway_mode usables
 * (para preguntar "¿y sin escalones?"). → { sec, modos } · sec null si no hay.
 */
function dijkstra(g, origenes, destinos, permitido = null) {
  const dist = new Map();
  const cola = [];
  for (const o of origenes) { dist.set(o, 0); cola.push({ d: 0, n: o, m: [] }); }
  while (cola.length) {
    let k = 0;
    for (let i = 1; i < cola.length; i++) if (cola[i].d < cola[k].d) k = i;
    const { d, n, m } = cola.splice(k, 1)[0];
    if (destinos.has(n)) {
      const modos = {};
      for (const x of m) modos[x] = (modos[x] || 0) + 1;
      return { sec: d, modos };
    }
    if (d > (dist.get(n) ?? Infinity)) continue;
    for (const [v, w, modo] of g.get(n) || []) {
      if (permitido && !permitido.has(modo)) continue;
      if (d + w < (dist.get(v) ?? Infinity)) {
        dist.set(v, d + w);
        cola.push({ d: d + w, n: v, m: [...m, modo] });
      }
    }
  }
  return { sec: null, modos: {} };
}

// ── Ruta GTFS (mejor esfuerzo, ver README) ─────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const header = rows.shift().map((h) => h.replace(/^﻿/, '').trim());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const slug = (name) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// El vocabulario de ids del proyecto (la spec del diagrama en sample-data.mjs
// y express-config.json) es anterior al GTFS y abrevia; el feed oficial
// escribe el nombre completo y slugifica distinto. Sin esta reconciliación,
// seis estaciones muy céntricas quedan fuera de la spec esquemática y el
// diagrama 2D las coloca por interpolación.
// Medido contra V166.20260704: son exactamente estas seis y ninguna más
// (126 estaciones padre en el feed = 126 en el proyecto).
const STATION_ALIASES = {
  'universidad-de-chile': 'u-de-chile',
  'universidad-catolica': 'u-catolica',
  'universidad-de-santiago': 'u-de-santiago',
  'puente-cal-y-canto': 'cal-y-canto',
  'parque-o-higgins': 'parque-ohiggins',
  'presidente-pedro-aguirre-cerda': 'pedro-aguirre-cerda',
};
const stationId = (name) => { const s = slug(name); return STATION_ALIASES[s] || s; };

const hhmmToSec = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const secToHHMM = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;

function buildFromGTFS(dir) {
  const read = (f) => parseCSV(fs.readFileSync(path.join(dir, f), 'utf8'));
  const has = (f) => fs.existsSync(path.join(dir, f));

  const routes = read('routes.txt').filter((r) => r.route_type === '1');
  if (!routes.length) throw new Error('el GTFS no contiene rutas con route_type=1 (metro)');
  const stops = new Map(read('stops.txt').map((s) => [s.stop_id, s]));
  const trips = read('trips.txt');
  const stopTimes = read('stop_times.txt');
  const freqs = has('frequencies.txt') ? read('frequencies.txt') : [];
  const calendar = has('calendar.txt') ? read('calendar.txt') : [];

  // service_id → tipo de día
  const dayType = new Map();
  for (const c of calendar) {
    const wd = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].some((d) => c[d] === '1');
    if (wd) dayType.set(c.service_id, 'wd');
    else if (c.saturday === '1') dayType.set(c.service_id, 'sa');
    else if (c.sunday === '1') dayType.set(c.service_id, 'su');
  }

  const stByTrip = new Map();
  for (const st of stopTimes) {
    if (!stByTrip.has(st.trip_id)) stByTrip.set(st.trip_id, []);
    stByTrip.get(st.trip_id).push(st);
  }
  for (const arr of stByTrip.values()) arr.sort((a, b) => +a.stop_sequence - +b.stop_sequence);

  const freqByTrip = new Map();
  for (const f of freqs) {
    if (!freqByTrip.has(f.trip_id)) freqByTrip.set(f.trip_id, []);
    freqByTrip.get(f.trip_id).push(f);
  }

  // spec esquemática de referencia (para asignar layout a estaciones conocidas)
  const sampleSchemByLine = new Map(LINES.map((l) => [l.id, l]));

  const stations = {};
  const lines = [];
  for (const route of routes) {
    const lineId = (route.route_short_name || route.route_id).toUpperCase().replace(/^(?!L)/, 'L');
    const rTrips = trips.filter((t) => t.route_id === route.route_id && (t.direction_id === '0' || !t.direction_id));
    if (!rTrips.length) continue;
    // viaje representativo: el de más paradas
    const best = rTrips.map((t) => ({ t, st: stByTrip.get(t.trip_id) || [] }))
      .sort((a, b) => b.st.length - a.st.length)[0];
    if (!best || best.st.length < 2) continue;

    const stationIds = [];
    for (const st of best.st) {
      const stop = stops.get(st.stop_id);
      if (!stop) continue;
      const parent = stop.parent_station && stops.get(stop.parent_station);
      const eff = parent || stop;
      const id = stationId(eff.stop_name);
      if (!stations[id]) stations[id] = { name: cleanName(eff.stop_name), lines: [], geo: project([+eff.stop_lon, +eff.stop_lat]), ll: [+eff.stop_lon, +eff.stop_lat] };
      if (!stations[id].lines.includes(lineId)) stations[id].lines.push(lineId);
      if (stationIds[stationIds.length - 1] !== id) stationIds.push(id);
    }

    // ── variantes expresas en el feed: trips de la misma línea/sentido con
    // distinto set de paradas, o headsigns "Roja/Verde/Expresa" ──
    const resolveIds = (sts) => {
      const ids = [];
      for (const st of sts) {
        const stop = stops.get(st.stop_id);
        if (!stop) continue;
        const parent = stop.parent_station && stops.get(stop.parent_station);
        const id = stationId((parent || stop).stop_name);
        if (ids[ids.length - 1] !== id) ids.push(id);
      }
      return ids;
    };
    const bySig = new Map();
    for (const t of rTrips) {
      const ids = resolveIds(stByTrip.get(t.trip_id) || []);
      if (ids.length < 2) continue;
      const sig = ids.join('>');
      if (!bySig.has(sig)) bySig.set(sig, { stops: ids, trips: [] });
      bySig.get(sig).trips.push(t);
    }
    // Un feed real trae muchas firmas de parada por línea y la mayoría NO son
    // expresas: son servicios cortos (trenes que dan la vuelta antes del
    // terminal) y viajes sueltos de entrada/salida de cochera. Medido contra
    // V166.20260704: L1 tiene 6 firmas, L3 15 y L6 7, y ninguna salta una sola
    // estación interior. Quedarse con "la 2ª y 3ª más larga" inventaba Ruta
    // Roja/Verde en L1, L3 y L6, que no la tienen.
    //
    // Ruta Expresa = mismos terminales que el servicio completo + salta al
    // menos una estación INTERIOR. Un servicio corto recorta por los extremos
    // y no salta nada en medio. El discriminante es exacto en el feed real:
    // las variantes de L2/L4/L5 saltan 7-9 interiores y su headsign dice
    // literalmente "(Ruta Roja)" / "(Ruta Verde)".
    const expressVariants = (sorted) => {
      const full = sorted[0].stops;
      const first = full[0], last = full[full.length - 1];
      return sorted.slice(1).filter((v) => {
        if (v.stops[0] !== first || v.stops[v.stops.length - 1] !== last) return false;
        const skipped = full.filter((id) => !v.stops.includes(id));
        return skipped.length > 0;
      });
    };

    let express;
    const sortedSigs = [...bySig.values()].sort((a, b) => b.stops.length - a.stops.length);
    const variants = sortedSigs.length > 1 ? expressVariants(sortedSigs).slice(0, 2) : [];
    if (variants.length) {
      const sorted = sortedSigs;
      const patterns = {}, vfreq = {};
      variants.forEach((v, i) => {
        const hs = (v.trips[0].trip_headsign || '').toLowerCase();
        const label = /roja/.test(hs) ? 'R' : /verde/.test(hs) ? 'V' : i === 0 ? 'R' : 'V';
        patterns[label] = v.stops;
        const byFreq = bandsFor(v.trips, dayType, freqByTrip);
        // el metro del DTPM va con horario explícito: si frequencies.txt no
        // cubre estos viajes, las bandas salen de las salidas reales
        const deps = departuresOf(v.trips, dayType, stByTrip, null);
        vfreq[label] = {
          wd: byFreq.wd.length ? byFreq.wd : bandsFromDepartures(deps.wd),
          sa: byFreq.sa.length ? byFreq.sa : bandsFromDepartures(deps.sa),
          su: byFreq.su.length ? byFreq.su : bandsFromDepartures(deps.su),
        };
      });
      const cls = {};
      for (const id of sorted[0].stops) {
        const inR = !patterns.R || patterns.R.includes(id);
        const inV = !patterns.V || patterns.V.includes(id);
        cls[id] = inR && inV ? 'C' : inR ? 'R' : 'V';
      }
      // La ventana expresa es la unión de las franjas de R y de V. Sin fundir,
      // R y V aportan tramos distintos del mismo periodo y quedan solapes
      // ("17:30-18:00", "18:00-20:30", "17:30-20:30"): un dato correcto pero
      // ilegible, y que impide leer el borde de la ventana desde el JSON.
      const windows = { wd: [], sa: [], su: [] };
      for (const d of ['wd', 'sa', 'su']) {
        const spans = [];
        for (const k of Object.keys(vfreq)) {
          for (const [a, b] of vfreq[k][d]) spans.push([hhmmToSec(a), hhmmToSec(b)]);
        }
        windows[d] = mergeSpans(spans).map(([a, b]) => [secToHHMM(a), secToHHMM(b)]);
      }
      express = { source: 'gtfs', windows, class: cls, patterns, freq: vfreq };
      console.log(`✓ ${lineId}: ${variants.length} variante(s) expresa(s) derivadas del feed`);
    } else {
      express = expressFromConfig(loadExpressConfig(), lineId, stationIds);
      if (express) console.log(`ℹ ${lineId}: sin variantes en el feed; operación expresa desde express-config.json`);
    }

    // frecuencias por tipo de día: frequencies.txt si el feed lo usa, si no
    // las salidas reales de stop_times.txt (que es el caso del metro del DTPM),
    // y sólo como último recurso el dataset de ejemplo.
    const routeTrips = trips.filter((x) => x.route_id === route.route_id);
    const freq = { wd: [], sa: [], su: [] };
    for (const t of routeTrips) {
      const dt = dayType.get(t.service_id) || 'wd';
      for (const f of freqByTrip.get(t.trip_id) || []) {
        freq[dt].push([secToHHMM(hhmmToSec(f.start_time)), secToHHMM(hhmmToSec(f.end_time)), +f.headway_secs]);
      }
    }
    // un sentido: el intervalo es por andén, no la suma de ambos
    const routeDeps = departuresOf(routeTrips, dayType, stByTrip, '0');
    const freqSource = { wd: 'frequencies', sa: 'frequencies', su: 'frequencies' };
    for (const k of ['wd', 'sa', 'su']) {
      freq[k] = dedupeBands(freq[k]);
      if (!freq[k].length) {
        freq[k] = bandsFromDepartures(routeDeps[k]);
        freqSource[k] = 'stop_times';
      }
      if (!freq[k].length) {
        freq[k] = (sampleSchemByLine.get(lineId)?.freq?.[k]) || [['06:00', '23:00', 300]];
        freqSource[k] = 'ejemplo';
        console.warn(`⚠ ${lineId}/${k}: el feed no permite derivar frecuencias; se usa el dataset de ejemplo.`);
      }
    }
    if (freqSource.wd === 'stop_times') {
      console.log(`  ${lineId}: frecuencias desde horario explícito (${routeDeps.wd.length} salidas hábiles)`);
    }
    const service = {};
    for (const k of ['wd', 'sa', 'su']) {
      service[k] = [freq[k][0][0], freq[k][freq[k].length - 1][1]];
    }

    // layout esquemático: usar la spec de ejemplo si cubre esta línea; si no,
    // degradar a la propia geografía (morph nulo pero funcional)
    const sample = sampleSchemByLine.get(lineId);
    let schemParts;
    if (sample && specCovers(sample.schematic, stationIds)) {
      schemParts = resolveSchematic(sample.schematic);
      schemParts.stationIds = stationIds;
      // specCovers acepta un 80 % de cobertura, pero assemble() exige una
      // coordenada esquemática por estación: las que el feed trae y la spec no
      // conoce (extensiones, nombres que cambiaron) se reparten sobre el
      // trazado del diagrama entre sus vecinas conocidas.
      fillSchemGaps(lineId, schemParts);
    } else {
      const coords = new Map(stationIds.map((id) => [id, stations[id].geo]));
      schemParts = { stationIds, coords, polyline: stationIds.map((id) => stations[id].geo) };
      console.warn(`⚠ ${lineId}: sin layout esquemático conocido; se usa la geografía como diagrama.`);
    }

    lines.push({
      id: lineId,
      name: route.route_long_name || `Línea ${lineId.slice(1)}`,
      color: route.route_color ? `#${route.route_color}` : (sample?.color || '#888888'),
      freq, service, express, ...schemParts,
    });
  }
  lines.sort((a, b) => a.id.localeCompare(b.id, 'es', { numeric: true }));

  // route_id → id de línea de la app, con la misma regla que arriba
  const lineaDeRuta = new Map(routes.map((r) => [
    r.route_id, (r.route_short_name || r.route_id).toUpperCase().replace(/^(?!L)/, 'L'),
  ]));
  const interiors = buildInteriors(read, has, stops, stopTimes, trips, lineaDeRuta);
  const cal = buildCalendar(read, has, dayType);
  console.log(`  calendario: ${Object.keys(cal.holidays).length} feriados · feed ${cal.version || '?'} vigente hasta ${cal.end || '?'}`);

  return assemble(lines, stations, 'gtfs', { interiors, calendar: cal });
}

// Quita el prefijo "Estación" de nombres como "Estación Los Héroes".
// Excepción: "Estación Central" ES el nombre propio de la estación (y de la
// comuna); sin esta salvedad el feed oficial la rotula "Central".
const cleanName = (n) => (/^estaci[oó]n\s+central$/i.test(n.trim())
  ? n.trim()
  : n.replace(/^Est(aci[oó]n)?\.?\s+/i, '').trim());

/**
 * Completa las estaciones que el GTFS trae y la spec esquemática no conoce.
 * Se reparten uniformemente por ARCO sobre la polilínea del diagrama entre las
 * dos vecinas que sí tienen coordenada, de modo que el orden se respeta y el
 * morph sigue siendo vértice a vértice. Muta parts.coords.
 *
 * No es silencioso a propósito: cada relleno se registra, porque una estación
 * mal ubicada en el diagrama no produce ningún síntoma visible.
 */
function fillSchemGaps(lineId, parts) {
  const { stationIds, coords, polyline } = parts;
  const missing = stationIds.filter((id) => !coords.has(id));
  if (!missing.length) return;

  const known = stationIds.map((id, i) => (coords.has(id) ? i : -1)).filter((i) => i >= 0);
  if (!known.length) return; // sin ancla: el llamador ya degradó a geografía

  const cum = cumLengths(polyline);
  const total = cum[cum.length - 1];
  const arc = new Map(known.map((i) => [i, nearestArc(polyline, cum, coords.get(stationIds[i]))]));
  // monotonía sobre las conocidas (la spec puede tener retrocesos numéricos)
  for (let k = 1; k < known.length; k++) {
    if (arc.get(known[k]) < arc.get(known[k - 1])) arc.set(known[k], arc.get(known[k - 1]));
  }

  const place = (i, s) => coords.set(stationIds[i], pointAtArc(polyline, cum, Math.max(0, Math.min(total, s))));
  const first = known[0], last = known[known.length - 1];

  // huecos interiores: repartir por arco entre las dos anclas
  for (let k = 0; k < known.length - 1; k++) {
    const a = known[k], b = known[k + 1];
    const gap = b - a - 1;
    if (gap <= 0) continue;
    const sA = arc.get(a), sB = arc.get(b);
    for (let n = 1; n <= gap; n++) place(a + n, sA + ((sB - sA) * n) / (gap + 1));
  }
  // colas: extender con el paso medio del tramo contiguo conocido
  if (first > 0) {
    const step = known.length > 1 ? (arc.get(known[1]) - arc.get(first)) / (known[1] - first) : total / stationIds.length;
    for (let i = first - 1; i >= 0; i--) place(i, arc.get(first) - step * (first - i));
  }
  if (last < stationIds.length - 1) {
    const step = known.length > 1 ? (arc.get(last) - arc.get(known[known.length - 2])) / (last - known[known.length - 2]) : total / stationIds.length;
    for (let i = last + 1; i < stationIds.length; i++) place(i, arc.get(last) + step * (i - last));
  }

  console.warn(`⚠ ${lineId}: ${missing.length} estación(es) sin posición en el diagrama, interpoladas: ${missing.join(', ')}`);
}

function specCovers(spec, stationIds) {
  const specIds = new Set(spec.filter((e) => typeof e === 'string' || e.pin).map((e) => (typeof e === 'string' ? e : e.pin)));
  const found = stationIds.filter((id) => specIds.has(id)).length;
  return found >= stationIds.length * 0.8;
}

function bandsFor(tripList, dayType, freqByTrip) {
  const out = { wd: [], sa: [], su: [] };
  for (const t of tripList) {
    const dt = dayType.get(t.service_id) || 'wd';
    for (const f of freqByTrip.get(t.trip_id) || []) {
      out[dt].push([secToHHMM(hhmmToSec(f.start_time)), secToHHMM(hhmmToSec(f.end_time)), +f.headway_secs]);
    }
  }
  for (const k of ['wd', 'sa', 'su']) out[k] = dedupeBands(out[k]);
  return out;
}

function dedupeBands(bands) {
  const seen = new Set();
  return bands
    .filter((b) => { const k = b.join('|'); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => hhmmToSec(a[0]) - hhmmToSec(b[0]));
}

// ── Frecuencias desde horario explícito ────────────────────────────────────
// El GTFS del DTPM NO describe el metro con frequencies.txt: los 10.438 viajes
// de L1–L6 van con horario explícito en stop_times.txt y ni uno solo aparece
// en frequencies.txt (medido sobre V166.20260704). Sin esta ruta, bandsFor()
// devuelve vacío y build-data.js cae al dataset de ejemplo justo en la
// magnitud que define el proyecto —cada cuánto sale un tren— mientras
// etiqueta meta.source como "gtfs".
//
// Se reconstruyen las bandas a partir de las salidas reales: se cuentan las
// salidas por franja de media hora, el intervalo de la franja es su inversa, y
// las franjas contiguas con intervalos parecidos se funden en una banda.

/** Salidas (s desde medianoche) del primer paradero de cada viaje, por tipo de día. */
function departuresOf(tripList, dayType, stByTrip, dirId = '0') {
  const byDayService = { wd: new Map(), sa: new Map(), su: new Map() };
  for (const t of tripList) {
    if (dirId != null && t.direction_id && t.direction_id !== dirId) continue;
    const sts = stByTrip.get(t.trip_id);
    if (!sts || !sts.length) continue;
    const hhmm = sts[0].departure_time || sts[0].arrival_time;
    if (!hhmm) continue;
    const dt = dayType.get(t.service_id) || 'wd';
    const m = byDayService[dt];
    if (!m.has(t.service_id)) m.set(t.service_id, []);
    m.get(t.service_id).push(hhmmToSec(hhmm));
  }
  // Un tipo de día puede tener VARIOS calendarios: el metro programa LJ
  // (lunes a jueves) y V (viernes) por separado, y F/D para el domingo.
  // Unirlos duplica las salidas y parte el intervalo por la mitad —L1 daba
  // 1 min en punta, contra los ~2 min reales—. Se toma el calendario
  // dominante, que es un día representativo y no la suma de dos.
  const out = { wd: [], sa: [], su: [] };
  for (const k of ['wd', 'sa', 'su']) {
    let best = [];
    for (const deps of byDayService[k].values()) if (deps.length > best.length) best = deps;
    out[k] = best.sort((a, b) => a - b);
  }
  return out;
}

const SLOT = 1800; // media hora

/** [[HH:MM, HH:MM, headwaySecs], …] a partir de una lista de salidas. */
function bandsFromDepartures(deps, { minTrips = 6, tol = 0.25 } = {}) {
  if (deps.length < minTrips) return [];
  const first = deps[0], last = deps[deps.length - 1];
  const s0 = Math.floor(first / SLOT) * SLOT;
  const s1 = Math.ceil((last + 1) / SLOT) * SLOT;

  // intervalo representativo por franja = duración / nº de salidas
  const slots = [];
  for (let s = s0; s < s1; s += SLOT) {
    const n = deps.filter((d) => d >= s && d < s + SLOT).length;
    if (!n) continue;
    slots.push({ s, headway: Math.round(SLOT / n) });
  }
  if (!slots.length) return [];

  // fundir franjas contiguas de intervalo parecido
  const bands = [];
  let cur = { from: slots[0].s, to: slots[0].s + SLOT, hs: [slots[0].headway] };
  for (let i = 1; i < slots.length; i++) {
    const sl = slots[i];
    const ref = median(cur.hs);
    const contiguo = sl.s === cur.to;
    if (contiguo && Math.abs(sl.headway - ref) <= ref * tol) {
      cur.to = sl.s + SLOT;
      cur.hs.push(sl.headway);
    } else {
      bands.push(cur);
      cur = { from: sl.s, to: sl.s + SLOT, hs: [sl.headway] };
    }
  }
  bands.push(cur);

  return bands.map((b) => [
    secToHHMM(b.from),
    secToHHMM(Math.min(b.to, 24 * 3600 - 60)),
    Math.max(60, Math.round(median(b.hs) / 10) * 10),
  ]);
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  return a[a.length >> 1];
}

/** Funde intervalos [ini,fin] solapados o contiguos. */
function mergeSpans(spans) {
  if (!spans.length) return [];
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  const out = [s[0].slice()];
  for (let i = 1; i < s.length; i++) {
    const last = out[out.length - 1];
    if (s[i][0] <= last[1]) last[1] = Math.max(last[1], s[i][1]);
    else out.push(s[i].slice());
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────
const gtfsDir = process.argv[2];
let network;
if (gtfsDir) {
  console.log(`Procesando GTFS en ${gtfsDir}…`);
  network = buildFromGTFS(gtfsDir);
} else {
  console.log('Sin GTFS: usando el dataset de ejemplo embebido.');
  network = buildFromSample();
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(network));
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`✓ ${OUT} (${kb} KB) — ${network.lines.length} líneas, ${Object.keys(network.stations).length} estaciones`);
for (const l of network.lines) {
  console.log(`  ${l.id}: ${l.stations.length} estaciones, ${(l.stationS[l.stationS.length - 1] / 1000).toFixed(1)} km`);
}
