// Relieve vertical de la red (levels.txt).
//
// POR QUÉ EXISTE ESTE ARCHIVO
// La primera versión dibujaba el relieve hacia ABAJO desde la calle, y hundía
// las líneas subterráneas por debajo de la capa de ciudad: L1 y L6
// desaparecían enteras de la pantalla, L2 y L3 al 95 %. Los 118 tests pasaban
// y el smoke daba 17/17, porque ninguno miraba la geometría vertical. Lo
// reportó una persona mirando la demo.
//
// Las dos invariantes que lo habrían atrapado están abajo, y son de datos
// puros: no hacen falta ni WebGL ni capturas.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { NetworkLayer, RELIEVE_REAL } from '../src/network.js';

const data = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8'));

// pendiente que una cinta puede tener antes de verse de canto desde la órbita
const PENDIENTE_MAX = 0.15;
// pendiente real máxima de un metro: el 4 % que la cabina no puede superar
const PENDIENTE_REAL_MAX = 0.04;

let net;
beforeAll(() => { net = new NetworkLayer(new THREE.Group(), data); });

describe('relieve vertical', () => {
  it('ninguna línea baja del plano base: si no, el suelo de la ciudad la tapa', () => {
    for (const [id, L] of net.lines) {
      const min = Math.min(...L.dy);
      expect(min, `${id} se hunde ${Math.round(-min)} m bajo la base`).toBeGreaterThanOrEqual(0);
    }
    // y el suelo del relieve es el andén más profundo de la red, no la calle
    expect(net.nivelMin).toBe(-5);
  });

  it('las pendientes no vuelven las cintas un tobogán', () => {
    let peor = 0, donde = '';
    for (const [id, L] of net.lines) {
      for (let i = 1; i < L.N; i++) {
        const ds = L.geoCum[i] - L.geoCum[i - 1];
        if (ds < 5) continue;
        const p = Math.abs(L.dy[i] - L.dy[i - 1]) / ds;
        if (p > peor) { peor = p; donde = id; }
      }
    }
    expect(peor, `${donde} llega al ${(peor * 100).toFixed(0)} %`).toBeLessThan(PENDIENTE_MAX);
  });

  it('a escala real (cabina) la pendiente cabe en lo que un metro puede subir', () => {
    let peor = 0;
    for (const L of net.lines.values()) {
      for (let i = 1; i < L.N; i++) {
        const ds = L.geoCum[i] - L.geoCum[i - 1];
        if (ds < 5) continue;
        peor = Math.max(peor, (Math.abs(L.dy[i] - L.dy[i - 1]) * RELIEVE_REAL) / ds);
      }
    }
    expect(peor).toBeLessThan(PENDIENTE_REAL_MAX);
  });

  it('la cota de cada estación es la de su andén, y respeta el orden real', () => {
    for (const [id, L] of net.lines) {
      L.def.stations.forEach((sid, k) => {
        const nivel = data.stations[sid].in?.prof?.[id];
        if (nivel === undefined) return;
        const esperado = (nivel - net.nivelMin) * 4.2 * 4.5;
        expect(net.alturaEn(id, L.def.stationS[k]), `${sid}/${id}`).toBeCloseTo(esperado, 1);
      });
    }
    // el viaducto de L5 va por encima de L1, y L1 por encima de L3 profunda
    const at = (l, s) => {
      const L = net.lines.get(l);
      return net.alturaEn(l, L.def.stationS[L.def.stations.indexOf(s)]);
    };
    expect(at('L5', 'laguna-sur')).toBeGreaterThan(at('L1', 'tobalaba'));
    expect(at('L1', 'tobalaba')).toBeGreaterThan(at('L3', 'plaza-de-armas'));
  });

  it('el diagrama esquemático es plano: un diagrama no tiene profundidad', () => {
    net.setMorph(1);
    for (const [id, L] of net.lines) expect(net.alturaEn(id, L.geoCum[L.N >> 1]), id).toBe(0);
    net.setMorph(0);
  });

  it('con relieve apagado la red vuelve exactamente a como era', () => {
    net.relieve = 0;
    for (const [id, L] of net.lines) expect(net.alturaEn(id, L.geoCum[L.N >> 1]), id).toBe(0);
    net.relieve = 1;
  });
});
