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
      if (!stations[id]) stations[id] = { name: STATIONS[id].name, lines: [], geo: project(STATIONS[id].ll) };
      stations[id].lines.push(l.id);
    }
  }
  return assemble(lines, stations, 'sample');
}

// ── Ensamblado común: curvas, morph y normalización ────────────────────────
function assemble(lines, stations, source) {
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
      geo: [round1(s.geo[0]), round1(s.geo[1])],
      schem: s.schem || [round1(s.geo[0]), round1(s.geo[1])],
    };
  }

  const river = catmullRom(RIVER.map(project), 8).map((p) => [round1(p[0]), round1(p[1])]);

  return {
    meta: { source, generated: new Date().toISOString(), samplesPerSeg: SAMPLES_PER_SEG },
    projection: { lat0: LAT0, lon0: LON0 },
    bbox: [round1(minX), round1(minY), round1(maxX), round1(maxY)],
    lines: outLines,
    stations: outStations,
    river,
  };
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
      const id = slug(eff.stop_name);
      if (!stations[id]) stations[id] = { name: cleanName(eff.stop_name), lines: [], geo: project([+eff.stop_lon, +eff.stop_lat]) };
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
        const id = slug((parent || stop).stop_name);
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
    let express;
    if (bySig.size > 1) {
      const sorted = [...bySig.values()].sort((a, b) => b.stops.length - a.stops.length);
      const variants = sorted.slice(1, 3);
      const patterns = {}, vfreq = {};
      variants.forEach((v, i) => {
        const hs = (v.trips[0].trip_headsign || '').toLowerCase();
        const label = /roja/.test(hs) ? 'R' : /verde/.test(hs) ? 'V' : i === 0 ? 'R' : 'V';
        patterns[label] = v.stops;
        vfreq[label] = bandsFor(v.trips, dayType, freqByTrip);
      });
      const cls = {};
      for (const id of sorted[0].stops) {
        const inR = !patterns.R || patterns.R.includes(id);
        const inV = !patterns.V || patterns.V.includes(id);
        cls[id] = inR && inV ? 'C' : inR ? 'R' : 'V';
      }
      const windows = { wd: [], sa: [], su: [] };
      for (const k of Object.keys(vfreq)) {
        for (const d of ['wd', 'sa', 'su']) {
          for (const [a, b] of vfreq[k][d]) {
            if (!windows[d].some(([x, y]) => x === a && y === b)) windows[d].push([a, b]);
          }
        }
      }
      express = { source: 'gtfs', windows, class: cls, patterns, freq: vfreq };
      console.log(`✓ ${lineId}: ${variants.length} variante(s) expresa(s) derivadas del feed`);
    } else {
      express = expressFromConfig(loadExpressConfig(), lineId, stationIds);
      if (express) console.log(`ℹ ${lineId}: sin variantes en el feed; operación expresa desde express-config.json`);
    }

    // frecuencias por tipo de día
    const freq = { wd: [], sa: [], su: [] };
    for (const t of trips.filter((x) => x.route_id === route.route_id)) {
      const dt = dayType.get(t.service_id) || 'wd';
      for (const f of freqByTrip.get(t.trip_id) || []) {
        freq[dt].push([secToHHMM(hhmmToSec(f.start_time)), secToHHMM(hhmmToSec(f.end_time)), +f.headway_secs]);
      }
    }
    for (const k of ['wd', 'sa', 'su']) {
      freq[k] = dedupeBands(freq[k]);
      if (!freq[k].length) freq[k] = (sampleSchemByLine.get(lineId)?.freq?.[k]) || [['06:00', '23:00', 300]];
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
  return assemble(lines, stations, 'gtfs');
}

const cleanName = (n) => n.replace(/^Est(aci[oó]n)?\.?\s+/i, '').trim();

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
