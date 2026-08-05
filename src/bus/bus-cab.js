// Vista de conductor del BUS, a escala real (1 unidad = 1 m).
//
// Es el análogo callejero de src/cab.js: allá el metro va por un túnel de
// Ø 5,8 m; acá el bus va por una avenida. Lo que hace legible la velocidad no
// son anillos de túnel sino el flujo óptico de la calle — eje segmentado cada
// 12 m y luminarias cada 30 m: a 20 km/h (la velocidad comercial real de RED)
// pasa medio poste por segundo. Los paraderos son las placas de andén de este
// mundo, y llevan el nombre oficial del GTFS.
//
// DE DÓNDE SALE EL MOVIMIENTO
// Cada frame se le PREGUNTA a BusSim dónde está este bus a la hora actual
// (estadoDe), en vez de integrar una velocidad. Por eso el viaje responde al
// scrubbing y a ×10/×60 igual que la vista orbital: si mueves el reloj, la
// cabina salta a donde el itinerario dice, sin acumular deriva.
//
// POR QUÉ SOLO SE VIAJA EN BUSES SIMULADOS
// Un bus del feed GPS es una foto de hace ~33 s. Viajar dentro de él exigiría
// inventar el movimiento entre medición y medición — justo lo que el resto del
// proyecto se niega a hacer. Se puede mirar un bus medido; no se puede
// conducirlo. La puerta está en main.js, no aquí.

import * as THREE from 'three';
import { gsap } from 'gsap';
import { dur, REDUCED_MOTION } from '../motion.js';

const FRONT = 6;           // m: parabrisas en la trompa (bus de 12 m)
const LOOK_AHEAD = 42;     // m: punto de mira sobre la curva
const CAB_HEIGHT = 2.45;   // m: el conductor de bus va alto
const LANE = 2.6;          // m a la derecha del eje: carril de circulación
const ROAD_HALF = 8;       // m: media calzada (avenida de dos por sentido)
const FOV_BASE = 74;       // algo más abierto que el metro: la calle es ancha
const FOV_BOOST = 4;

const DASH_SPACING = 12, DASH_COUNT = 44;   // eje segmentado
const LAMP_SPACING = 30, LAMP_COUNT = 30;   // luminarias, alternando lado
const NEIGH_MAX = 28;      // otros buses dibujados a escala real
const NEIGH_R = 460;       // m: hasta dónde se ven
const FOG_NEAR = 16, FOG_FAR = 340;

export class BusCab {
  /**
   * @param placer   BusPlacer (trazados y puntos sobre el arco)
   * @param catalog  StopCatalog (nombres oficiales de paradero)
   * @param sim      BusSim (estadoDe: dónde está este bus a esta hora)
   * @param getLista () → buses simulados del frame, para los vecinos
   */
  constructor(scene, placer, catalog, sim, getLista) {
    this.scene = scene;
    this.placer = placer;
    this.catalog = catalog;
    this.sim = sim;
    this.getLista = getLista || (() => []);

    this.cam = new THREE.PerspectiveCamera(FOV_BASE, innerWidth / innerHeight, 0.3, 6000);
    this.active = false;
    this.entering = false;
    this.exiting = false;
    this.key = null;
    this.shape = null;
    this.blend = 0;
    this.speed = 0;         // m/s suavizado (FOV, bamboleo)
    this.motivoSalida = null;
    this.onExit = null;

    // ── calle (solo en escena durante el viaje) ──
    this.group = new THREE.Group();
    this.dashes = new THREE.InstancedMesh(
      new THREE.BoxGeometry(4, 0.02, 0.22),
      new THREE.MeshBasicMaterial({ color: 0xb8b070 }),
      DASH_COUNT,
    );
    this.lamps = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.22, 6, 4),
      new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false,
      }),
      LAMP_COUNT,
    );
    this.posts = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.09, 0.09, 7.5, 5),
      new THREE.MeshBasicMaterial({ color: 0x2e2e36 }),
      LAMP_COUNT,
    );
    // otros buses: cajas a tamaño real (12 × 3,1 × 2,55 m)
    this.neigh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(12, 3.1, 2.55),
      new THREE.MeshBasicMaterial({ color: 0xc98a12 }),
      NEIGH_MAX,
    );
    this.dashes.frustumCulled = this.lamps.frustumCulled = false;
    this.posts.frustumCulled = this.neigh.frustumCulled = false;
    this.stopsGroup = new THREE.Group();
    this.roadGroup = new THREE.Group();
    this.group.add(this.dashes, this.lamps, this.posts, this.neigh, this.stopsGroup, this.roadGroup);

    this._signs = new Map();   // stopIdx → textura del nombre (cache entre viajes)
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._startPos = new THREE.Vector3();
    this._startQuat = new THREE.Quaternion();
  }

  /**
   * Sube a un bus simulado. `key` es la del bus (ruta|sentido|banda|salida).
   * Devuelve false si a esta hora ese bus no circula.
   */
  enter(key, view, sec, day) {
    if (this.active) return false;
    const b = this.sim.estadoDe(key, sec, day);
    if (!b) return false;

    this.active = true;
    this.entering = true;
    this.key = key;
    this.shape = b.shape;
    this.route = b.route;
    this.dir = b.dir;
    this.speed = b.v;
    this.motivoSalida = null;

    this._buildRoad(b.shape);
    this._buildStops(b.route, b.dir, b.shape);
    this.scene.add(this.group);

    this._saved = {
      fogNear: this.scene.fog.near,
      fogFar: this.scene.fog.far,
      orbitPos: view.persp.position.clone(),
      orbitQuat: view.persp.quaternion.clone(),
    };
    view.controls3d.enabled = false;

    this._startPos.copy(view.persp.position);
    this._startQuat.copy(view.persp.quaternion);
    this.cam.fov = view.persp.fov;
    this.cam.aspect = innerWidth / innerHeight;
    this.cam.updateProjectionMatrix();

    this.blend = 0;
    gsap.killTweensOf([this, this.scene.fog, this.cam]);
    gsap.to(this, {
      blend: 1, duration: dur(1.5), ease: 'power3.inOut',
      onComplete: () => { this.entering = false; },
    });
    gsap.to(this.scene.fog, { near: FOG_NEAR, far: FOG_FAR, duration: dur(1.5), ease: 'power2.in' });
    gsap.to(this.cam, {
      fov: FOV_BASE, duration: dur(1.5), ease: 'power2.inOut',
      onUpdate: () => this.cam.updateProjectionMatrix(),
    });
    this._view = view;
    return true;
  }

  exit(motivo = 'usuario') {
    if (!this.active || this.exiting) return;
    this.exiting = true;
    this.entering = false;
    this.motivoSalida = motivo;
    this._startPos.copy(this.cam.position);
    this._startQuat.copy(this.cam.quaternion);
    gsap.killTweensOf([this, this.scene.fog, this.cam]);
    gsap.to(this, {
      blend: 0, duration: dur(1.5), ease: 'power3.inOut',
      onUpdate: () => {
        this.cam.position.lerpVectors(this._saved.orbitPos, this._startPos, this.blend);
        this.cam.quaternion.slerpQuaternions(this._saved.orbitQuat, this._startQuat, this.blend);
      },
      onComplete: () => {
        this.active = false;
        this.exiting = false;
        this.key = null;
        this.scene.remove(this.group);
        this._disposeRoad();
        this._view.controls3d.enabled = true;
        this.onExit?.(this.motivoSalida);
      },
    });
    gsap.to(this.scene.fog, {
      near: this._saved.fogNear, far: this._saved.fogFar,
      duration: dur(1.5), ease: 'power2.out',
    });
    gsap.to(this.cam, {
      fov: this._view.persp.fov, duration: dur(1.5),
      onUpdate: () => this.cam.updateProjectionMatrix(),
    });
  }

  /**
   * Avanza la cabina. Devuelve el estado del bus (para el HUD) o null.
   * @param dt segundos de frame real; sec/day, hora oficial
   */
  update(dt, sec, day) {
    if (!this.active) return null;
    if (this.exiting) return null;
    const b = this.sim.estadoDe(this.key, sec, day);
    if (!b) {
      // llegó al terminal, o el reloj se movió fuera de su viaje
      this.exit('terminal');
      return null;
    }
    // la velocidad del itinerario es constante por tramo: se suaviza sólo
    // para la cámara (FOV y bamboleo), nunca para el velocímetro
    this.speed += (b.v - this.speed) * Math.min(1, dt * 1.6);

    if (this._pose(b.s, this._pos, this._quat)) {
      if (this.entering) {
        this.cam.position.lerpVectors(this._startPos, this._pos, this.blend);
        this.cam.quaternion.slerpQuaternions(this._startQuat, this._quat, this.blend);
      } else {
        this.cam.position.copy(this._pos);
        this.cam.quaternion.slerp(this._quat, 1 - Math.exp(-dt * 4));
        if (!REDUCED_MOTION) {
          // un bus bambolea más que un tren: suspensión blanda, pavimento
          const k = Math.min(1, this.speed / 8);
          const tt = performance.now() / 1000;
          this.cam.position.y += (0.05 * Math.sin(tt * 6.3) + 0.022 * Math.sin(tt * 17.7)) * k;
          const sway = 0.05 * Math.sin(tt * 4.1) * k;
          this.cam.position.x += this._rx * sway;
          this.cam.position.z += this._rz * sway;
        }
        const targetFov = FOV_BASE + FOV_BOOST * Math.min(1, this.speed / 9);
        if (Math.abs(this.cam.fov - targetFov) > 0.05) {
          this.cam.fov += (targetFov - this.cam.fov) * Math.min(1, dt * 3);
          this.cam.updateProjectionMatrix();
        }
      }
    }
    this._updateStreet(b.s);
    this._updateNeighbours();
    return b;
  }

  /** Pose de la cabina: trompa del bus en el carril derecho, mirando la curva. */
  _pose(s, outPos, outQuat) {
    const a = this.placer.puntoEn(this.shape, s + FRONT);
    const b = this.placer.puntoEn(this.shape, s + FRONT + LOOK_AHEAD);
    if (!a || !b) return false;
    // derecha del rumbo local: (sin h, cos h) — el bus circula por ahí
    this._rx = Math.sin(a.heading); this._rz = Math.cos(a.heading);
    outPos.set(a.x + this._rx * LANE, CAB_HEIGHT, a.z + this._rz * LANE);
    _look.set(
      b.x + Math.sin(b.heading) * LANE,
      outPos.y - 0.55,
      b.z + Math.cos(b.heading) * LANE,
    );
    this._m.lookAt(outPos, _look, _up);
    outQuat.setFromRotationMatrix(this._m);
    return true;
  }

  // ── flujo óptico de la calle: eje y luminarias en ventana móvil ──────────
  _updateStreet(s) {
    const t = this.placer.trazado(this.shape);
    const total = t ? t.len : 0;
    const sCam = s + FRONT;

    this._placePool(this.dashes, DASH_COUNT, DASH_SPACING, sCam, total, (sp) => {
      const p = this.placer.puntoEn(this.shape, sp);
      if (!p) return false;
      this._q.setFromAxisAngle(_up, p.heading);
      this._s.setScalar(1);
      this._m.compose(_v.set(p.x, 0.03, p.z), this._q, this._s);
      return true;
    });

    // luminarias alternando vereda; el poste y su luz comparten posición
    let w = 0;
    const start = sCam - LAMP_SPACING * Math.floor(LAMP_COUNT * 0.12);
    const s0 = Math.ceil(start / LAMP_SPACING) * LAMP_SPACING;
    for (let i = 0; i < LAMP_COUNT; i++) {
      const sp = s0 + i * LAMP_SPACING;
      if (sp < 0 || sp > total) continue;
      const p = this.placer.puntoEn(this.shape, sp);
      if (!p) continue;
      const lado = (Math.round(sp / LAMP_SPACING) % 2) ? 1 : -1;
      const rx = Math.sin(p.heading) * (ROAD_HALF + 0.6) * lado;
      const rz = Math.cos(p.heading) * (ROAD_HALF + 0.6) * lado;
      this._m.makeTranslation(p.x + rx, 3.75, p.z + rz);
      this.posts.setMatrixAt(w, this._m);
      this._m.makeTranslation(p.x + rx * 0.82, 7.4, p.z + rz * 0.82);
      this.lamps.setMatrixAt(w, this._m);
      w++;
    }
    for (let i = w; i < LAMP_COUNT; i++) {
      this.posts.setMatrixAt(i, _hideM);
      this.lamps.setMatrixAt(i, _hideM);
    }
    this.posts.instanceMatrix.needsUpdate = true;
    this.lamps.instanceMatrix.needsUpdate = true;
  }

  /** Otros buses de la ciudad, a escala real, dentro del alcance de la vista. */
  _updateNeighbours() {
    const cx = this.cam.position.x, cz = this.cam.position.z;
    const r2 = NEIGH_R * NEIGH_R;
    let w = 0;
    for (const b of this.getLista()) {
      if (w >= NEIGH_MAX) break;
      if (b.key === this.key) continue; // el bus en el que vamos no se dibuja
      const p = this.placer.puntoEn(b.shape, b.s);
      if (!p) continue;
      const x = p.x + Math.sin(p.heading) * LANE;
      const z = p.z + Math.cos(p.heading) * LANE;
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz > r2) continue;
      this._q.setFromAxisAngle(_up, p.heading);
      this._s.setScalar(1);
      this._m.compose(_v.set(x, 1.6, z), this._q, this._s);
      this.neigh.setMatrixAt(w++, this._m);
    }
    for (let i = w; i < NEIGH_MAX; i++) this.neigh.setMatrixAt(i, _hideM);
    this.neigh.count = Math.max(w, 1);
    this.neigh.instanceMatrix.needsUpdate = true;
  }

  /** Ventana móvil de un pool alrededor de sCam (12 % detrás, resto delante). */
  _placePool(mesh, count, spacing, sCam, total, place) {
    const start = sCam - spacing * Math.floor(count * 0.12);
    const s0 = Math.ceil(start / spacing) * spacing;
    let w = 0;
    for (let i = 0; i < count; i++) {
      const s = s0 + i * spacing;
      if (s >= 0 && s <= total && place(s)) mesh.setMatrixAt(w++, this._m);
    }
    for (let i = w; i < count; i++) mesh.setMatrixAt(i, _hideM);
    mesh.instanceMatrix.needsUpdate = true;
  }

  // ── calzada y veredas: cintas estáticas del trazado (el fog las corta) ───
  _buildRoad(shapeId) {
    this._disposeRoad();
    const t = this.placer.trazado(shapeId);
    if (!t) return;
    const specs = [
      { off: 0, w: ROAD_HALF * 2, y: 0.01, c: 0x17171c },        // calzada
      { off: ROAD_HALF + 1.6, w: 3.2, y: 0.16, c: 0x232329 },    // vereda derecha
      { off: -(ROAD_HALF + 1.6), w: 3.2, y: 0.16, c: 0x232329 }, // vereda izquierda
      { off: ROAD_HALF, w: 0.35, y: 0.17, c: 0x3a3a44 },         // solera derecha
      { off: -ROAD_HALF, w: 0.35, y: 0.17, c: 0x3a3a44 },        // solera izquierda
    ];
    for (const sp of specs) this.roadGroup.add(ribbon(t, sp.off, sp.w, sp.y, sp.c));
  }

  _disposeRoad() {
    for (const m of this.roadGroup.children) { m.geometry.dispose(); m.material.dispose(); }
    this.roadGroup.clear();
    for (const g of this.stopsGroup.children) {
      for (const m of g.children) { if (m.material?.map) m.material.dispose(); }
    }
    this.stopsGroup.clear();
  }

  // ── paraderos: el letrero con el nombre oficial, sobre la vereda derecha ──
  _buildStops(route, dir, shapeId) {
    this.stopsGroup.clear();
    const pat = this.placer.patterns[route]?.[dir];
    const arcos = this.placer.arcos(route, dir);
    if (!pat || !arcos) return;
    for (let j = 0; j < pat.st.length; j++) {
      const p = this.placer.puntoEn(shapeId, arcos[j]);
      if (!p) continue;
      const g = new THREE.Group();
      g.position.set(p.x, 0, p.z);
      g.rotation.y = p.heading; // +z local queda a la derecha de la marcha
      // poste y panel sobre la vereda; en Chile el paradero va a la derecha
      const poste = new THREE.Mesh(_posteGeo, _posteMat);
      poste.position.set(0, 1.35, ROAD_HALF + 1.1);
      g.add(poste);
      const panel = new THREE.Mesh(
        _panelGeo,
        new THREE.MeshBasicMaterial({
          map: this._signTexture(pat.st[j]), side: THREE.DoubleSide,
          toneMapped: false, fog: false, transparent: true,
        }),
      );
      panel.position.set(0, 2.75, ROAD_HALF + 1.1);
      panel.rotation.y = Math.PI; // mirando a la calzada
      g.add(panel);
      this.stopsGroup.add(g);
    }
  }

  _signTexture(stopIdx) {
    if (this._signs.has(stopIdx)) return this._signs.get(stopIdx);
    const nombre = (this.catalog.name(stopIdx) || this.catalog.code(stopIdx) || '').toUpperCase();
    const code = this.catalog.code(stopIdx) || '';
    const c = document.createElement('canvas');
    c.width = 384; c.height = 96;
    const g = c.getContext('2d');
    g.fillStyle = '#101018';
    g.fillRect(0, 0, 384, 96);
    g.fillStyle = '#e2231a';       // franja RED
    g.fillRect(0, 0, 384, 10);
    g.fillStyle = '#8f8f9c';
    g.font = "600 17px Hind, 'Fira Sans', sans-serif";
    g.textBaseline = 'middle';
    g.fillText(code, 14, 30);
    g.fillStyle = '#ffffff';
    let size = 28;
    g.font = `600 ${size}px Hind, 'Fira Sans', sans-serif`;
    while (g.measureText(nombre).width > 356 && size > 12) {
      size -= 2;
      g.font = `600 ${size}px Hind, 'Fira Sans', sans-serif`;
    }
    g.fillText(nombre, 14, 65);
    const tx = new THREE.CanvasTexture(c);
    tx.anisotropy = 4;
    this._signs.set(stopIdx, tx);
    return tx;
  }
}

/** Cinta paralela al trazado, desplazada lateralmente (calzada, veredas). */
function ribbon(t, offset, width, y, color) {
  const n = t.cum.length;
  const pos = new Float32Array(n * 2 * 3);
  const idx = [];
  for (let i = 0; i < n; i++) {
    const iP = Math.max(0, i - 1), iN = Math.min(n - 1, i + 1);
    let dx = t.x[iN] - t.x[iP], dz = t.z[iN] - t.z[iP];
    const l = Math.hypot(dx, dz) || 1e-9;
    dx /= l; dz /= l;
    const px = -dz, pz = dx; // perpendicular derecha de +s
    const cx = t.x[i] + px * offset, cz = t.z[i] + pz * offset;
    const hw = width / 2;
    pos.set([cx - px * hw, y, cz - pz * hw, cx + px * hw, y, cz + pz * hw], i * 6);
    if (i < n - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color }));
  mesh.frustumCulled = false;
  return mesh;
}

const _up = new THREE.Vector3(0, 1, 0);
const _look = new THREE.Vector3();
const _v = new THREE.Vector3();
const _hideM = new THREE.Matrix4().makeScale(0, 0, 0);
const _posteGeo = new THREE.CylinderGeometry(0.07, 0.07, 2.7, 5);
const _posteMat = new THREE.MeshBasicMaterial({ color: 0x33333c });
const _panelGeo = new THREE.PlaneGeometry(2.4, 0.6);
