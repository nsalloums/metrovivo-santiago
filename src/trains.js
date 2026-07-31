// Trenes: cápsulas alargadas instanciadas (un solo draw call) con color de
// línea "emisivo" (material sin luz, saturado) y una luz frontal tenue como
// segundo InstancedMesh de puntos blancos. En 2D se aplanan a píldoras.
//
// Para que el movimiento a escala ciudad se perciba en x1:
// - estela corta degradada tras cada tren (quads aditivos del color de la
//   línea, que se apagan cuando el tren se detiene), y
// - pulso sutil del tren mientras está detenido en el andén.
// Cada sentido va desplazado lateralmente a su vía (doble vía), lo que además
// separa a los trenes que se cruzan en la vista de cabina.

import * as THREE from 'three';
import { REDUCED_MOTION } from './motion.js';

const CAPACITY = 256;
// Tamaño "maqueta" (legible desde la órbita) y tamaño real (vista de cabina);
// el parámetro cabBlend interpola entre ambos. Todo en METROS.
const LEN = 340;           // largo maqueta
const R = 42;              // radio maqueta
const REAL_LEN = 140;      // tren real NS-tipo: ~140 m
const REAL_R = 1.7;
const LIFT = 75;           // altura del eje sobre la vía (maqueta)
const REAL_LIFT = 2.0;
const TRACK_OFFSET = 50;   // separación lateral por sentido (maqueta)
const REAL_OFFSET = 1.8;   // vía doble real: ±1.8 m del eje
const K_TRAIL = 5;         // fantasmas de estela por tren
const TRAIL_STEP = 115;    // separación entre fantasmas (m)

const lerp = (a, b, t) => a + (b - a) * t;

export class TrainLayer {
  constructor(scene, network) {
    this.network = network;
    this.hideKey = null; // tren oculto (el que "conduces" en cabina)

    const body = new THREE.CapsuleGeometry(R, LEN - 2 * R, 4, 12);
    body.rotateZ(Math.PI / 2); // cápsula tumbada sobre su eje X local

    this.mesh = new THREE.InstancedMesh(
      body,
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      CAPACITY,
    );
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.mesh.renderOrder = 20;
    this.mesh.frustumCulled = false;

    const light = new THREE.SphereGeometry(28, 8, 6);
    this.lights = new THREE.InstancedMesh(
      light,
      new THREE.MeshBasicMaterial({ color: 0xfff6d8, transparent: true, opacity: 0.85, toneMapped: false }),
      CAPACITY,
    );
    this.lights.renderOrder = 21;
    this.lights.frustumCulled = false;

    // badge de ruta expresa: marcador rojo/verde sobre el techo del tren
    // (visible también aplanado en 2D, mirando desde arriba)
    this.flags = new THREE.InstancedMesh(
      new THREE.SphereGeometry(21, 8, 6),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      CAPACITY,
    );
    this.flags.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.flags.renderOrder = 22;
    this.flags.frustumCulled = false;

    // estelas: quads planos aditivos (el desvanecido va codificado en el color)
    const ghost = new THREE.PlaneGeometry(1, 1);
    ghost.rotateX(-Math.PI / 2);
    this.trails = new THREE.InstancedMesh(
      ghost,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      CAPACITY * K_TRAIL,
    );
    this.trails.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * K_TRAIL * 3), 3);
    this.trails.renderOrder = 18;
    this.trails.frustumCulled = false;

    scene.add(this.trails, this.mesh, this.lights, this.flags);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._tp = new THREE.Vector3();
    this._td = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
    this._state = new Map(); // key → {trail, dwell} suavizados
    this.instanceTrain = new Array(CAPACITY).fill(null); // instanceId → tren
    // pool de posiciones en pantalla para el picking tolerante (sin allocations)
    this._screen = Array.from({ length: CAPACITY }, () => ({ train: null, x: 0, y: 0, z: 0 }));
    this._screenCount = 0;
    this.visibleCount = 0;
  }

  /**
   * @param trains   lista de la simulación (con .key)
   * @param flatten  0 = cápsula 3D, 1 = píldora aplanada (vista plano)
   * @param dt       delta de frame (s) para suavizados
   * @param nowS     reloj monótono (s) para el pulso
   * @param cabBlend 0 = escala maqueta (órbita), 1 = escala real (cabina)
   */
  update(trains, flatten, dt = 0.016, nowS = 0, cabBlend = 0) {
    let w = 0, wt = 0;
    const hide = _hideM;
    const cb = cabBlend;
    const latOff = lerp(TRACK_OFFSET * (1 - flatten * 0.6), REAL_OFFSET, cb);
    const lift = lerp(LIFT, REAL_LIFT, cb);
    const lenScale = lerp(1, REAL_LEN / LEN, cb);   // escala longitudinal
    const radScale = lerp(1, REAL_R / R, cb);       // escala radial
    for (const t of trains) {
      if (w >= CAPACITY) break;
      if (!this.network.isActive(t.lineId)) continue;
      if (t.key === this.hideKey) continue;
      const sign = t.dir === 0 ? 1 : -1;
      this.network.pointAt(t.lineId, t.sGeo, t.sSchem, this._p, this._d);
      if (t.dir === 1) this._d.multiplyScalar(-1);
      // vía propia: desplazar a la derecha del sentido de marcha
      const rx = -this._d.z, rz = this._d.x;
      this._p.x += rx * latOff; this._p.z += rz * latOff;
      this._p.y += lift;

      // estado suavizado por tren (estela y pulso de detención)
      let st = this._state.get(t.key);
      if (!st) { st = { trail: t.moving ? 1 : 0, dwell: 0, dim: 0, seen: 0 }; this._state.set(t.key, st); }
      st.seen = nowS;
      const kTrail = Math.min(1, dt * 2.5), kDwell = Math.min(1, dt * 4);
      // trenes congelados por contingencia: atenuados, sin pulso ni estela
      st.dim += ((t.frozen ? 1 : 0) - (st.dim ?? 0)) * Math.min(1, dt * 2);
      const dim = 1 - 0.68 * st.dim;
      st.trail += ((t.moving && !t.frozen ? 1 : 0) - st.trail) * kTrail;
      st.dwell += ((t.moving ? 0 : 1) - st.dwell) * kDwell;
      const pulse = REDUCED_MOTION || t.frozen ? 1 : 1 + 0.09 * Math.sin(nowS * 3.2) * st.dwell;

      const yaw = Math.atan2(-this._d.z, this._d.x);
      this._q.setFromAxisAngle(this._up, yaw);
      const squash = 1 - 0.72 * flatten;
      this._s.set(
        pulse * lenScale,
        squash * pulse * radScale,
        (1 + 0.15 * flatten) * pulse * radScale,
      );
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(w, this._m);

      this._c.copy(this.network.lineColor(t.lineId)).multiplyScalar(1.35 * dim);
      this.mesh.setColorAt(w, this._c);
      this.instanceTrain[w] = t;
      const sc = this._screen[w];
      sc.train = t; sc.x = this._p.x; sc.y = this._p.y; sc.z = this._p.z;

      // luz frontal en la trompa (apagada si el tren quedó congelado)
      const tip = 0.55 * LEN * lenScale;
      const lightK = t.frozen ? 0 : 1;
      this._m.makeScale(radScale * lightK, squash * radScale * lightK, radScale * lightK).setPosition(
        this._p.x + this._d.x * tip,
        this._p.y,
        this._p.z + this._d.z * tip,
      );
      this.lights.setMatrixAt(w, this._m);

      // badge de ruta expresa sobre el techo (oculto para trenes comunes)
      if (!t.frozen && (t.pattern === 'R' || t.pattern === 'V')) {
        this._m.makeScale(radScale * 1.4, squash * radScale, radScale * 1.4).setPosition(
          this._p.x,
          this._p.y + (R * squash + 16) * radScale,
          this._p.z,
        );
        this.flags.setMatrixAt(w, this._m);
        this._c.setHex(t.pattern === 'R' ? 0xff2d1f : 0x00d45a);
        this.flags.setColorAt(w, this._c);
      } else {
        this.flags.setMatrixAt(w, _hideM);
      }

      // estela: fantasmas por detrás del tren, apagándose con la distancia y
      // con el factor de movimiento (sin estela cuando está detenido).
      // Es un recurso de la vista orbital: se funde al entrar a cabina, y con
      // prefers-reduced-motion no se dibuja.
      const trailOn = !REDUCED_MOTION && cb < 0.98;
      for (let g = 0; g < (trailOn ? K_TRAIL : 0); g++) {
        const back = LEN * lenScale * 0.5 + (g + 0.7) * TRAIL_STEP;
        this.network.pointAt(t.lineId, t.sGeo - sign * back, t.sSchem - sign * back, this._tp, this._td);
        if (t.dir === 1) this._td.multiplyScalar(-1);
        this._tp.x += -this._td.z * latOff; this._tp.z += this._td.x * latOff;
        this._tp.y += lift - lerp(18, 1.2, cb);
        const gy = Math.atan2(-this._td.z, this._td.x);
        this._q.setFromAxisAngle(this._up, gy);
        this._s.set(TRAIL_STEP * 1.35, 1, lerp(85, 4, cb) * (1 - (0.55 * g) / K_TRAIL));
        this._m.compose(this._tp, this._q, this._s);
        this.trails.setMatrixAt(wt, this._m);
        const fade = Math.pow(1 - g / K_TRAIL, 1.7) * 0.5 * st.trail * (1 - cb);
        this._c.copy(this.network.lineColor(t.lineId)).multiplyScalar(fade);
        this.trails.setColorAt(wt, this._c);
        wt++;
      }
      w++;
    }
    for (let i = w; i < this.mesh.count; i++) {
      this.mesh.setMatrixAt(i, hide);
      this.lights.setMatrixAt(i, hide);
      this.flags.setMatrixAt(i, hide);
    }
    for (let i = wt; i < this.trails.count; i++) this.trails.setMatrixAt(i, hide);
    this.mesh.count = this.lights.count = this.flags.count = Math.max(w, 1);
    this.trails.count = Math.max(wt, 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.lights.instanceMatrix.needsUpdate = true;
    this.flags.instanceMatrix.needsUpdate = true;
    this.flags.instanceColor.needsUpdate = true;
    this.trails.instanceMatrix.needsUpdate = true;
    this.trails.instanceColor.needsUpdate = true;
    this._screenCount = w;
    this.visibleCount = w;

    // limpiar estados de trenes que ya no existen (barrido perezoso)
    if (this._state.size > w * 2 + 32) {
      for (const [k, s] of this._state) if (s.seen !== nowS) this._state.delete(k);
    }
  }

  /** Tren dibujado más cercano en pantalla a (px,py), dentro de maxPx. */
  nearestOnScreen(px, py, camera, maxPx = 26) {
    const v = _proj;
    let best = null, bestD = maxPx * maxPx;
    for (let i = 0; i < this._screenCount; i++) {
      const e = this._screen[i];
      v.set(e.x, e.y, e.z).project(camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * innerWidth;
      const sy = (-v.y * 0.5 + 0.5) * innerHeight;
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bestD) { bestD = d; best = e.train; }
    }
    return best;
  }
}

const _hideM = new THREE.Matrix4().makeScale(0, 0, 0);
const _proj = new THREE.Vector3();
