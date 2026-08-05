// Auditoría de unidades: 1 unidad = 1 metro. La proyección local debe
// entregar distancias reales: haversine entre estaciones vs distancia
// euclidiana en la escena, error < 2%.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8'));

function haversine([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const euclid = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// pares con distinta orientación y largo (corto, medio, largo, diagonal)
const PAIRS = [
  ['san-pablo', 'los-dominicos'],       // L1 completa E-O, ~16 km
  ['vespucio-norte', 'hospital-el-pino'], // N-S, ~22 km
  ['los-heroes', 'baquedano'],          // céntrico, ~2.5 km
  ['tobalaba', 'plaza-egana'],          // ~4 km
  ['la-cisterna', 'vicuna-mackenna'],   // diagonal sur
  ['baquedano', 'salvador'],            // tramo corto ~900 m
];

describe('escala: 1 unidad = 1 metro', () => {
  // El haversine se calcula con las MISMAS lat/lon que generaron la escena
  // (station.ll), no con las del dataset de ejemplo: así el test mide el error
  // de la proyección y no el de una tabla de coordenadas paralela. Con las del
  // ejemplo el error aparente llegaba al 12,6 %, que era desviación del dato
  // de origen (~640 m de mediana), no de la proyección.
  it.each(PAIRS)('distancia %s ↔ %s: proyección vs haversine < 2%', (a, b) => {
    const hav = haversine(data.stations[a].ll, data.stations[b].ll);
    const scene = euclid(data.stations[a].geo, data.stations[b].geo);
    const err = Math.abs(scene - hav) / hav;
    expect(err, `haversine ${hav.toFixed(0)} m vs escena ${scene.toFixed(0)} m`).toBeLessThan(0.02);
  });

  it('los tramos de L1 están en órdenes de magnitud reales (300-2200 m)', () => {
    const l1 = data.lines.find((l) => l.id === 'L1');
    for (let i = 0; i < l1.stations.length - 1; i++) {
      const D = l1.stationS[i + 1] - l1.stationS[i];
      expect(D).toBeGreaterThan(300);  // el más corto real (~centro) ronda 340 m
      expect(D).toBeLessThan(2200);
      const T = Math.max(45, D / 13.9); // misma fórmula del motor
      const media = (D / T) * 3.6;
      expect(media).toBeGreaterThan(20);
      expect(media).toBeLessThanOrEqual(51);
    }
  });
});
