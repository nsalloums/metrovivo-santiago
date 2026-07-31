#!/usr/bin/env node
// Auditoría de unidades y perfiles: imprime por tramo de una línea el largo
// (m), tiempo programado (s), velocidad media y crucero del perfil
// trapezoidal (km/h). Uso: node scripts/audit-units.mjs [L1]

import { readFileSync } from 'node:fs';
import { Simulation } from '../src/sim.js';
import { STATIONS } from './sample-data.mjs';

const data = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8'));
const sim = new Simulation(data);
const lineId = process.argv[2] || 'L1';
const L = sim.byId.get(lineId);
if (!L) { console.error(`línea desconocida: ${lineId}`); process.exit(1); }

function haversine([lon1, lat1], [lon2, lat2]) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

console.log(`\nEscala: 1 unidad = 1 metro. Verificación haversine (muestras):`);
for (const [a, b] of [['san-pablo', 'los-dominicos'], ['los-heroes', 'baquedano']]) {
  if (!STATIONS[a] || !data.stations[a]) continue;
  const hav = haversine(STATIONS[a].ll, STATIONS[b].ll);
  const ga = data.stations[a].geo, gb = data.stations[b].geo;
  const scene = Math.hypot(ga[0] - gb[0], ga[1] - gb[1]);
  console.log(`  ${a} ↔ ${b}: haversine ${hav.toFixed(0)} m · escena ${scene.toFixed(0)} m · error ${((Math.abs(scene - hav) / hav) * 100).toFixed(2)}%`);
}

console.log(`\n${lineId} — tramos (esperable Santiago: 500-900 m, 25-35 km/h de media):\n`);
console.log('  tramo                                          largo    T     media  crucero');
const S = L.def.stationS;
const names = (i) => data.stations[L.def.stations[i]].name;
for (let i = 0; i < L.prof.length; i++) {
  const D = S[i + 1] - S[i];
  const T = L.sched[0].arr[i + 1] - L.sched[0].dep[i];
  const media = (D / T) * 3.6;
  const cruise = L.prof[i].v * 3.6;
  const seg = `${names(i)} → ${names(i + 1)}`.padEnd(45).slice(0, 45);
  console.log(`  ${seg} ${String(Math.round(D)).padStart(5)} m ${String(Math.round(T)).padStart(4)} s ${media.toFixed(1).padStart(6)} ${cruise.toFixed(1).padStart(7)} km/h`);
}
const total = S[S.length - 1];
console.log(`\n  total ${(total / 1000).toFixed(1)} km · viaje ${(L.trip / 60).toFixed(1)} min · media comercial ${((total / L.trip) * 3.6).toFixed(1)} km/h (con paradas)`);
