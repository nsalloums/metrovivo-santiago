// Vista de conductor (cab view) a ESCALA REAL (1 unidad = 1 m).
//
// El resto de la escena es una maqueta sobredimensionada para leerse desde
// la órbita; al entrar a cabina, TrainLayer re-escala los trenes a tamaño
// real (cabBlend) y aquí se construye un entorno de túnel con proporciones
// de metro: Ø ~5.8 m, cámara a 2.2 m sobre el riel, anillos cada 10 m,
// luces cada 13 m, rieles/durmientes/cables. El flujo óptico cercano es lo
// que hace legible la velocidad: a 60 km/h pasa ~1 luz por segundo y ~5
// durmientes por segundo.
//
// Anillos, luces y durmientes son pools instanciados reposicionados en una
// ventana móvil alrededor de la cámara; rieles y cables son cintas estáticas
// construidas una vez por línea al entrar (el fog las corta a ~230 m).

import * as THREE from 'three';
import { gsap } from 'gsap';
import { dur, REDUCED_MOTION } from './motion.js';
import { RELIEVE_REAL } from './network.js';

const FRONT = 70;         // m: parabrisas en la trompa del tren real (140/2)
const LOOK_AHEAD = 55;    // m: punto de mira sobre la curva
const CAB_HEIGHT = 2.2;   // m sobre el riel
const LAT = 1.8;          // m: offset a la vía del sentido de marcha (real)
const FOV_BASE = 72;      // FOV cabina (70-75°) + boost dinámico en crucero
const FOV_BOOST = 4.5;

const RING_SPACING = 10;  // m entre anillos de túnel
const RING_COUNT = 72;
const RING_R = 2.9;       // radio del túnel (Ø 5.8 m)
const LAMP_SPACING = 13;  // m entre luces de pared (~1/s a 60 km/h)
const LAMP_COUNT = 56;
const SLEEPER_SPACING = 3.5; // m entre durmientes (~5/s a 60 km/h)
const SLEEPER_COUNT = 160;   // repartidos entre ambas vías
const STATION_ZONE = 80;  // m sin anillos alrededor de cada estación
const FOG_NEAR = 12, FOG_FAR = 230; // el detalle aparece, pasa y se va

export class CabView {
  constructor(scene, network, sim, data) {
    this.scene = scene;
    this.network = network;
    this.sim = sim;
    this.data = data;

    this.cam = new THREE.PerspectiveCamera(FOV_BASE, innerWidth / innerHeight, 0.3, 5000);
    this.active = false;
    this.entering = false;
    this.exiting = false;
    this.key = null;
    this.blend = 0;
    this.speed = 0; // m/s del tren seguido (para FOV/bob/velocímetro)

    // ── túnel (solo se agrega a escena en cab view) ──
    this.group = new THREE.Group();
    this.rings = new THREE.InstancedMesh(
      new THREE.TorusGeometry(RING_R, 0.09, 6, 20),
      new THREE.MeshBasicMaterial({ color: 0x262633 }),
      RING_COUNT,
    );
    this.lamps = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.13, 6, 4),
      new THREE.MeshBasicMaterial({
        color: 0xffc98a, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false,
      }),
      LAMP_COUNT,
    );
    this.sleepers = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.32, 0.14, 2.5),
      new THREE.MeshBasicMaterial({ color: 0x232329 }),
      SLEEPER_COUNT,
    );
    this.rings.frustumCulled = this.lamps.frustumCulled = this.sleepers.frustumCulled = false;
    this.stationsGroup = new THREE.Group();
    this.trackGroup = new THREE.Group(); // rieles y cables (estáticos por línea)
    this.group.add(this.rings, this.lamps, this.sleepers, this.stationsGroup, this.trackGroup);

    this._plaques = new Map(); // stationId → textura (cache entre viajes)
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._startPos = new THREE.Vector3();
    this._startQuat = new THREE.Quaternion();
    this.onExit = null; // callback al terminar la salida
  }

  /** Pose objetivo de la cabina para un tren (posición + orientación). */
  _pose(t, outPos, outQuat) {
    const sign = t.dir === 0 ? 1 : -1;
    const sFront = t.sGeo + sign * FRONT;
    this.network.pointAt(t.lineId, sFront, t.sSchem, this._p, this._d);
    if (t.dir === 1) this._d.multiplyScalar(-1);
    const rx = -this._d.z, rz = this._d.x;
    outPos.set(this._p.x + rx * LAT, this._p.y + CAB_HEIGHT, this._p.z + rz * LAT);
    // mirar a un punto adelantado sobre la curva (mismo carril)
    this.network.pointAt(t.lineId, sFront + sign * LOOK_AHEAD, t.sSchem, this._p, this._d);
    if (t.dir === 1) this._d.multiplyScalar(-1);
    _look.set(this._p.x + (-this._d.z) * LAT, outPos.y - 0.9, this._p.z + this._d.x * LAT);
    this._m.lookAt(outPos, _look, _up);
    outQuat.setFromRotationMatrix(this._m);
  }

  /**
   * @param express clasificación R/V/C para las placas de andén, solo si la
   *   ventana expresa está vigente al entrar: {class: {stationId: cls}} | null
   */
  enter(train, view, express = null) {
    if (this.active) return;
    this.active = true;
    this.entering = true;
    this.key = train.key;
    this.lineId = train.lineId;
    this.speed = 0;
    this._express = express;

    this._buildTrack(train.lineId);
    this._buildStationZones(train.lineId);
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
  }

  exit() {
    if (!this.active || this.exiting) return;
    this.exiting = true;
    this.entering = false;
    this._startPos.copy(this.cam.position);
    this._startQuat.copy(this.cam.quaternion);
    gsap.killTweensOf([this, this.scene.fog, this.cam]);
    gsap.to(this, {
      blend: 0, duration: dur(1.5), ease: 'power3.inOut',
      onUpdate: () => {
        // volver volando a la pose orbital guardada
        this.cam.position.lerpVectors(this._saved.orbitPos, this._startPos, this.blend);
        this.cam.quaternion.slerpQuaternions(this._saved.orbitQuat, this._startQuat, this.blend);
      },
      onComplete: () => {
        this.active = false;
        this.exiting = false;
        this.key = null;
        this.scene.remove(this.group);
        this._disposeTrack();
        this._view.controls3d.enabled = true;
        this.onExit?.();
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
   * Avanza la cabina. Devuelve el tren seguido (para el HUD) o null.
   * dt en segundos de frame real.
   */
  update(dt) {
    if (!this.active) return null;
    const t = this.sim.byKey.get(this.key);
    if (!t) { this.exit(); return null; } // el viaje terminó
    this.speed = (t.vKmh || 0) / 3.6;
    if (!this.exiting) {
      this._pose(t, this._pos, this._quat);
      if (this.entering) {
        this.cam.position.lerpVectors(this._startPos, this._pos, this.blend);
        this.cam.quaternion.slerpQuaternions(this._startQuat, this._quat, this.blend);
      } else {
        this.cam.position.copy(this._pos);
        // suavizado de rotación para no vibrar en curvas
        this.cam.quaternion.slerp(this._quat, 1 - Math.exp(-dt * 4.5));
        // micro-vibración y bob proporcionales a la velocidad
        if (!REDUCED_MOTION) {
          const k = Math.min(1, this.speed / 22);
          const tt = performance.now() / 1000;
          this.cam.position.y += (0.035 * Math.sin(tt * 8.7) + 0.012 * Math.sin(tt * 23.1)) * k;
          const rx = -this._d.z, rz = this._d.x; // lateral local
          const sway = 0.025 * Math.sin(tt * 6.1) * k;
          this.cam.position.x += rx * sway;
          this.cam.position.z += rz * sway;
        }
        // FOV dinámico: +4.5° al llegar a crucero (sensación de velocidad)
        const targetFov = FOV_BASE + FOV_BOOST * Math.min(1, this.speed / 16.7);
        if (Math.abs(this.cam.fov - targetFov) > 0.05) {
          this.cam.fov += (targetFov - this.cam.fov) * Math.min(1, dt * 3);
          this.cam.updateProjectionMatrix();
        }
      }
    }
    this._updateTunnel(t);
    return t;
  }

  // ── túnel procedural con pooling ─────────────────────────────────────────
  _updateTunnel(t) {
    const def = this.sim.byId.get(t.lineId).def;
    const total = def.stationS[def.stationS.length - 1];
    const sign = t.dir === 0 ? 1 : -1;
    const sCam = t.sGeo + sign * FRONT;

    this._placePool(this.rings, RING_COUNT, RING_SPACING, sCam, sign, total, 0, (s) => {
      if (nearestStationDist(def.stationS, s) < STATION_ZONE) return false;
      this.network.pointAt(t.lineId, s, s, this._p, this._d);
      this._q.setFromUnitVectors(_zAxis, this._d);
      this._s.setScalar(1);
      this._m.compose(this._p.setY(this._p.y + 2.3), this._q, this._s);
      return true;
    });

    this._placePool(this.lamps, LAMP_COUNT, LAMP_SPACING, sCam, sign, total, 0, (s) => {
      if (nearestStationDist(def.stationS, s) < STATION_ZONE) return false;
      this.network.pointAt(t.lineId, s, s, this._p, this._d);
      this._p.x += -this._d.z * 2.55;
      this._p.z += this._d.x * 2.55;
      this._p.y += 3.2;
      this._m.makeTranslation(this._p.x, this._p.y, this._p.z);
      return true;
    });

    // durmientes bajo ambas vías (mitad del pool para cada una)
    const half = SLEEPER_COUNT / 2;
    for (const [slot, side] of [[0, LAT], [half, -LAT]]) {
      this._placePool(this.sleepers, half, SLEEPER_SPACING, sCam, sign, total, slot, (s) => {
        this.network.pointAt(t.lineId, s, s, this._p, this._d);
        const yaw = Math.atan2(-this._d.z, this._d.x);
        this._p.x += -this._d.z * side;
        this._p.z += this._d.x * side;
        this._p.y += 0.07;
        this._q.setFromAxisAngle(_up, yaw);
        this._s.setScalar(1);
        this._m.compose(this._p, this._q, this._s);
        return true;
      });
    }
  }

  /**
   * Reposiciona un pool instanciado en una ventana móvil alrededor de sCam:
   * ~15% detrás de la cámara, el resto por delante. `place(s)` llena this._m
   * y devuelve false para saltar esa posición (p. ej. zonas de estación).
   */
  _placePool(mesh, count, spacing, sCam, sign, total, slot, place) {
    const start = sCam - sign * spacing * Math.floor(count * 0.15);
    const s0 = sign > 0 ? Math.ceil(start / spacing) * spacing : Math.floor(start / spacing) * spacing;
    let w = 0;
    for (let i = 0; i < count; i++) {
      const s = s0 + sign * i * spacing;
      if (s >= 0 && s <= total && place(s)) mesh.setMatrixAt(slot + w++, this._m);
    }
    for (let i = w; i < count; i++) mesh.setMatrixAt(slot + i, _hideM);
    mesh.instanceMatrix.needsUpdate = true;
  }

  // ── rieles y cables: cintas estáticas por línea (el fog las corta) ──────
  _buildTrack(lineId) {
    this._disposeTrack();
    const L = this.network.lines.get(lineId);
    // dos rieles por vía (trocha 1.44 m) y un cable lateral por pared
    const specs = [
      { off: LAT - 0.72, w: 0.16, y: 0.16, c: 0x3f3f48 },
      { off: LAT + 0.72, w: 0.16, y: 0.16, c: 0x3f3f48 },
      { off: -LAT - 0.72, w: 0.16, y: 0.16, c: 0x34343c },
      { off: -LAT + 0.72, w: 0.16, y: 0.16, c: 0x34343c },
      { off: 2.78, w: 0.07, y: 3.5, c: 0x2a2a32 },
      { off: -2.78, w: 0.07, y: 3.5, c: 0x2a2a32 },
    ];
    for (const sp of specs) {
      // Los rieles siguen el relieve de la vía, no una cota plana: si no, en
      // una bajada de dos niveles la cabina viaja por debajo de sus propios
      // rieles. A escala REAL, que es la de este mundo — ver RELIEVE_REAL.
      this.trackGroup.add(offsetRibbon(L.geoPts, L.N, L.y, sp.off, sp.w, sp.y, sp.c, L.dy, RELIEVE_REAL));
    }
  }

  _disposeTrack() {
    for (const m of this.trackGroup.children) { m.geometry.dispose(); m.material.dispose(); }
    this.trackGroup.clear();
  }

  // ── zonas de estación: andén, placa señalética y luz cenital ────────────
  _buildStationZones(lineId) {
    this.stationsGroup.clear();
    const def = this.sim.byId.get(lineId).def;
    const color = this.data.lines.find((l) => l.id === lineId).color;
    for (let i = 0; i < def.stations.length; i++) {
      const id = def.stations[i];
      const s = def.stationS[i];
      this.network.pointAt(lineId, s, s, this._p, this._d);
      // el grupo rota con el rumbo local: +z local queda a la derecha de +s
      const yaw = Math.atan2(-this._d.z, this._d.x);
      const g = new THREE.Group();
      g.position.copy(this._p);
      g.rotation.y = yaw;

      // andén lateral (borde a ~1.6 m del eje de la vía, piso a +1.1 m)
      const slab = new THREE.Mesh(_slabGeo, _slabMat);
      slab.position.set(0, 0.55, 3.5);
      g.add(slab);
      // luz cenital difusa de la zona de estación
      const glow = new THREE.Mesh(_glowGeo, _glowMat);
      glow.position.y = 4.6;
      g.add(glow);
      // placa de andén con el nombre (estilo señalética), mirando a la vía
      const cls = this._express?.class?.[id] || null;
      const plaque = new THREE.Mesh(
        _plaqueGeo,
        new THREE.MeshBasicMaterial({
          map: this._plaqueTexture(id, color, cls), side: THREE.DoubleSide,
          toneMapped: false, fog: false,
        }),
      );
      plaque.position.set(0, 2.7, 5.3);
      plaque.rotation.y = Math.PI;
      g.add(plaque);
      this.stationsGroup.add(g);
    }
  }

  _plaqueTexture(stationId, lineColor, cls = null) {
    const key = `${stationId}|${cls || ''}`;
    if (this._plaques.has(key)) return this._plaques.get(key);
    const name = this.data.stations[stationId].name.toUpperCase();
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#101018';
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = lineColor;
    g.fillRect(0, 0, 16, 128);
    const maxW = cls ? 380 : 452;
    g.fillStyle = '#ffffff';
    let size = 52;
    g.font = `600 ${size}px Hind, 'Fira Sans', sans-serif`;
    while (g.measureText(name).width > maxW && size > 22) {
      size -= 4;
      g.font = `600 ${size}px Hind, 'Fira Sans', sans-serif`;
    }
    g.textBaseline = 'middle';
    g.fillText(name, 40, 66);
    if (cls) {
      // clasificación de ruta expresa: círculo R/V/C al estilo señalética
      g.fillStyle = cls === 'R' ? '#d42317' : cls === 'V' ? '#00953f' : '#3a3a46';
      g.beginPath();
      g.arc(462, 64, 34, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = '700 44px Hind, sans-serif';
      g.textAlign = 'center';
      g.fillText(cls, 462, 66);
      g.textAlign = 'left';
    }
    const tx = new THREE.CanvasTexture(c);
    tx.anisotropy = 4;
    this._plaques.set(key, tx);
    return tx;
  }
}

/**
 * Cinta paralela al trazado, desplazada lateralmente (rieles, cables).
 * `relieve` (opcional) es la cota por muestra de la vía: sin ella la cinta
 * sería plana y se despegaría del trazado en cuanto la línea cambia de nivel.
 */
function offsetRibbon(pts, N, baseY, offset, width, dy, color, relieve = null, k = 1) {
  const pos = new Float32Array(N * 2 * 3);
  const idx = [];
  for (let i = 0; i < N; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    const iP = Math.max(0, i - 1) * 2, iN = Math.min(N - 1, i + 1) * 2;
    let dx = pts[iN] - pts[iP], dz = pts[iN + 1] - pts[iP + 1];
    const l = Math.hypot(dx, dz) || 1e-9;
    dx /= l; dz /= l;
    const px = -dz, pz = dx; // perpendicular (derecha de +s)
    const cx = x + px * offset, cz = z + pz * offset;
    const hw = width / 2;
    const y = baseY + dy + (relieve ? relieve[i] * k : 0);
    pos.set([cx - px * hw, y, cz - pz * hw, cx + px * hw, y, cz + pz * hw], i * 6);
    if (i < N - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color }));
  mesh.frustumCulled = false;
  return mesh;
}

function nearestStationDist(stationS, s) {
  let lo = 0, hi = stationS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stationS[mid] < s) lo = mid + 1; else hi = mid;
  }
  const a = Math.abs(stationS[lo] - s);
  const b = lo > 0 ? Math.abs(stationS[lo - 1] - s) : Infinity;
  return Math.min(a, b);
}

const _up = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _look = new THREE.Vector3();
const _hideM = new THREE.Matrix4().makeScale(0, 0, 0);
const _slabGeo = new THREE.BoxGeometry(140, 1.1, 3.6);
const _slabMat = new THREE.MeshBasicMaterial({ color: 0x2b2b36 });
const _glowGeo = new THREE.PlaneGeometry(150, 11);
_glowGeo.rotateX(Math.PI / 2);
const _glowMat = new THREE.MeshBasicMaterial({
  color: 0x8f8fae, transparent: true, opacity: 0.5,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  toneMapped: false, fog: false, // la estación se ve iluminada a la distancia
});
const _plaqueGeo = new THREE.PlaneGeometry(5, 1.25);
