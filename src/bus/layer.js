// Capa de buses: paraderos, el recorrido del bus que sigues, y el bus.
//
// LA DECISIÓN VISUAL QUE IMPORTA
// El tren simulado se dibuja como una cápsula nítida. El bus real se dibuja
// como una mancha. Es al revés de lo que uno esperaría, y es a propósito:
//
//   · el tren es una ficción matemática limpia — sabemos exactamente dónde
//     "debería" estar según el horario;
//   · el bus es una medición sucia — la API dice a cuántos metros del paradero
//     está, el dato nace con ~33 s encima, y contrastado contra posiciones GPS
//     reales el residuo se queda en varios cientos de metros.
//
// Dibujar el bus como un punto nítido afirmaría una precisión que no tenemos.
// La banda ES el dato: se extiende hacia adelante sobre el recorrido cubriendo
// lo que el bus pudo avanzar desde que se midió, y crece sola mientras no
// llega una lectura nueva. Cuando llega, salta. Ese salto es honesto: no
// sabemos por dónde pasó, sabemos dónde estaba y dónde está.
//
// El RECORRIDO, en cambio, sí se dibuja nítido: es geometría oficial del DTPM,
// y se verificó que las posiciones GPS reales caen sobre él (mediana 3 m).

import * as THREE from 'three';
import { REDUCED_MOTION } from '../motion.js';

const STOP_Y = 90;
const STOP_R = 26;
const BUS_Y = 150;
const RUTA_Y = 40;
const RUTA_W = 34;
const BANDA_SEGMENTOS = 24;

export class BusLayer {
  constructor(scene, catalog) {
    this.catalog = catalog;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.visible = false;
    this.group.visible = false;
    this._fade = 1;

    // ── paraderos: 12.134 discos en un solo draw call ──
    const n = catalog.size;
    this.dots = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(STOP_R, STOP_R, 16, 6),
      new THREE.MeshBasicMaterial({ color: 0x6f7d8c, transparent: true, opacity: 0.55, depthWrite: false }),
      n,
    );
    this.dots.renderOrder = 9;
    this.dots.frustumCulled = false;
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      m.makeTranslation(catalog.x[i], STOP_Y, catalog.z[i]);
      this.dots.setMatrixAt(i, m);
    }
    this.dots.instanceMatrix.needsUpdate = true;
    this.group.add(this.dots);

    // ── paradero elegido ──
    this.marca = new THREE.Mesh(
      new THREE.RingGeometry(90, 130, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
    );
    this.marca.rotation.x = -Math.PI / 2;
    this.marca.renderOrder = 16;
    this.marca.visible = false;
    this.group.add(this.marca);

    // ── recorrido del bus seguido (nítido: es dato oficial) ──
    this.ruta = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x00b4d8, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    this.ruta.frustumCulled = false;
    this.ruta.renderOrder = 8;
    this.ruta.visible = false;
    this.group.add(this.ruta);

    // ── banda de incertidumbre (el bus está EN ALGÚN PUNTO de aquí) ──
    this.banda = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x00e5ff, transparent: true, opacity: 0.3,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    this.banda.frustumCulled = false;
    this.banda.renderOrder = 17;
    this.banda.visible = false;
    this.group.add(this.banda);

    // ── el bus: el punto medido, difuso a propósito ──
    this.bus = new THREE.Mesh(
      new THREE.SphereGeometry(70, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.75, toneMapped: false }),
    );
    this.bus.renderOrder = 18;
    this.bus.visible = false;
    this.group.add(this.bus);
  }

  setVisible(on) { this.visible = on; this.group.visible = on && this._fade > 0.02; }

  /** Los paraderos son geografía: se apagan al pasar al diagrama esquemático. */
  setFade(f) {
    this._fade = f;
    this.dots.material.opacity = 0.55 * f;
    this.ruta.material.opacity = 0.5 * f;
    this.group.visible = this.visible && f > 0.02;
  }

  seleccionar(i) {
    if (i == null || i < 0) { this.marca.visible = false; return; }
    this.marca.position.set(this.catalog.x[i], STOP_Y + 10, this.catalog.z[i]);
    this.marca.visible = true;
  }

  /** Dibuja el recorrido completo del servicio seguido. */
  mostrarRuta(trazado) {
    if (!trazado) { this.ruta.visible = false; return; }
    const { x, z } = trazado;
    const n = x.length;
    const pos = new Float32Array(n * 2 * 3);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const iP = Math.max(0, i - 1), iN = Math.min(n - 1, i + 1);
      let dx = x[iN] - x[iP], dz = z[iN] - z[iP];
      const l = Math.hypot(dx, dz) || 1e-9;
      dx /= l; dz /= l;
      const px = (-dz * RUTA_W) / 2, pz = (dx * RUTA_W) / 2;
      const o = i * 6;
      pos[o] = x[i] - px; pos[o + 1] = RUTA_Y; pos[o + 2] = z[i] - pz;
      pos[o + 3] = x[i] + px; pos[o + 4] = RUTA_Y; pos[o + 5] = z[i] + pz;
      if (i < n - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.ruta.geometry.dispose();
    this.ruta.geometry = g;
    this.ruta.visible = true;
  }

  /**
   * Coloca el bus medido y su banda.
   * @param placer  BusPlacer (para muestrear el arco)
   * @param fix     resultado de placer.locate()
   * @param edadMs  cuánto hace que se midió
   */
  mostrarBus(placer, fix, edadMs) {
    if (!fix?.ok) { this.bus.visible = this.banda.visible = false; return; }

    const p = placer.puntoEn(fix.shapeId, fix.s);
    this.bus.position.set(p.x, BUS_Y, p.z);
    this.bus.visible = true;

    const { desde, hasta } = placer.banda(fix.s, edadMs);
    const largo = Math.max(1, hasta - desde);
    // la banda se dibuja SOBRE el recorrido, no como una barra recta: a escala
    // de ciudad una barra recta corta las curvas y sale de la calle
    const pos = new Float32Array((BANDA_SEGMENTOS + 1) * 2 * 3);
    const idx = [];
    for (let k = 0; k <= BANDA_SEGMENTOS; k++) {
      const s = desde + (largo * k) / BANDA_SEGMENTOS;
      const a = placer.puntoEn(fix.shapeId, s);
      const b = placer.puntoEn(fix.shapeId, s + 12);
      let dx = b.x - a.x, dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1e-9;
      dx /= l; dz /= l;
      // se estrecha hacia el final: donde es menos probable que esté
      const w = 105 * (1 - 0.45 * (k / BANDA_SEGMENTOS));
      const px = -dz * w, pz = dx * w;
      const o = k * 6;
      pos[o] = a.x - px; pos[o + 1] = BUS_Y - 40; pos[o + 2] = a.z - pz;
      pos[o + 3] = a.x + px; pos[o + 4] = BUS_Y - 40; pos[o + 5] = a.z + pz;
      if (k < BANDA_SEGMENTOS) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.banda.geometry.dispose();
    this.banda.geometry = g;
    this.banda.visible = true;
  }

  ocultarBus() {
    this.bus.visible = false;
    this.banda.visible = false;
    this.ruta.visible = false;
  }

  /** Latido suave del marcador: recuerda que el dato es vivo, no estático. */
  pulso(nowS) {
    if (!this.bus.visible || REDUCED_MOTION) return;
    const k = 1 + 0.12 * Math.sin(nowS * 2.2);
    this.bus.scale.setScalar(k);
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.dots.geometry.dispose();
    this.dots.material.dispose();
  }
}
