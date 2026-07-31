// Gestión de cámara y transición 2D↔3D.
//
// Un solo renderer, dos cámaras: perspectiva (maqueta 3D con órbita) y
// ortográfica (plano cenital). El switch es un timeline GSAP (~1.2 s,
// power2.inOut) que eleva y endereza la cámara mientras reduce el FOV
// (dolly-zoom manteniendo constante la altura visible), de modo que la
// perspectiva converge a la ortográfica sin saltos; al final se intercambia
// la cámara activa. El mismo progreso alimenta el morph geografía↔diagrama.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { gsap } from 'gsap';
import { dur } from './motion.js';

const FOV_3D = 55;
const FOV_MIN = 9; // FOV final del dolly-zoom (visualmente ortográfico)
const UP_3D = new THREE.Vector3(0, 1, 0);
const UP_2D = new THREE.Vector3(0, 0, -1); // norte hacia arriba en pantalla
const DOWN = new THREE.Vector3(0, 1, 0);   // dirección cámara-desde-objetivo en cenital

export class ViewManager {
  constructor(dom, geoCenter, geoSize, schemCenter, schemSize) {
    this.dom = dom;
    const aspect = dom.clientWidth / dom.clientHeight;

    // Unidades: metros. Near alto para conservar precisión de profundidad
    // (la órbita nunca se acerca a menos de ~2.5 km).
    this.persp = new THREE.PerspectiveCamera(FOV_3D, aspect, 100, 400000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 100, 400000);
    this.ortho.up.copy(UP_2D);

    this.schemCenter = schemCenter.clone();
    // altura visible que encuadra el diagrama completo, con aire extra en
    // vertical para que header y HUD no tapen los terminales
    this.schemV = Math.max(schemSize.y * 1.42, schemSize.x / aspect * 1.15);

    // pose 3D inicial: maqueta inclinada mirando la red completa
    const dist = Math.max(geoSize.x, geoSize.y) * 1.05;
    const az = -0.35, polar = 0.82; // radianes
    this.persp.position.set(
      geoCenter.x + dist * Math.sin(polar) * Math.sin(az),
      dist * Math.cos(polar),
      geoCenter.z + dist * Math.sin(polar) * Math.cos(az),
    );
    this.persp.lookAt(geoCenter);

    this.controls3d = new OrbitControls(this.persp, dom);
    this.controls3d.target.copy(geoCenter);
    this.controls3d.enableDamping = true;
    this.controls3d.dampingFactor = 0.07;
    this.controls3d.maxPolarAngle = 1.38;
    this.controls3d.minDistance = 2500;
    this.controls3d.maxDistance = 90000;

    this.controls2d = new OrbitControls(this.ortho, dom);
    this.controls2d.enableRotate = false;
    this.controls2d.screenSpacePanning = true;
    this.controls2d.enableDamping = true;
    this.controls2d.dampingFactor = 0.1;
    this.controls2d.minZoom = 0.7;
    this.controls2d.maxZoom = 14;
    this.controls2d.enabled = false;
    this.controls2d.touches.ONE = THREE.TOUCH.PAN;

    this.mode = '3d';
    this.blend = 0; // 0 = 3D/geografía, 1 = 2D/diagrama
    this.transitioning = false;
    this._saved3d = null;
  }

  get camera() { return this.mode === '2d' ? this.ortho : this.persp; }

  update() {
    if (this.transitioning) return;
    (this.mode === '3d' ? this.controls3d : this.controls2d).update();
  }

  resize() {
    const aspect = this.dom.clientWidth / this.dom.clientHeight;
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    const v = this._orthoV || this.schemV;
    this.ortho.top = v / 2; this.ortho.bottom = -v / 2;
    this.ortho.left = -v * aspect / 2; this.ortho.right = v * aspect / 2;
    this.ortho.updateProjectionMatrix();
  }

  /** Alterna 2D/3D. onProgress(blend) recibe el progreso eased para el morph. */
  toggle(onProgress) {
    if (this.transitioning) return null;
    return this.mode === '3d' ? this._to2d(onProgress) : this._to3d(onProgress);
  }

  _to2d(onProgress) {
    this.transitioning = true;
    this.controls3d.enabled = false;

    const target0 = this.controls3d.target.clone();
    const pos0 = this.persp.position.clone();
    const offset0 = pos0.clone().sub(target0);
    const d0 = offset0.length();
    const dir0 = offset0.normalize();
    const fov0 = this.persp.fov;
    const v0 = 2 * d0 * Math.tan(THREE.MathUtils.degToRad(fov0 / 2));
    this._saved3d = { target: target0.clone(), dir: dir0.clone(), v: v0, fov: fov0 };

    const target1 = this.schemCenter;
    const v1 = this.schemV;
    const qRot = new THREE.Quaternion().setFromUnitVectors(dir0, DOWN);

    return this._run(0, 1, (p) => {
      const fov = THREE.MathUtils.lerp(fov0, FOV_MIN, p);
      const v = THREE.MathUtils.lerp(v0, v1, p);
      const d = v / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
      _q.identity().slerp(qRot, p);
      _dir.copy(dir0).applyQuaternion(_q);
      _target.lerpVectors(target0, target1, p);
      this.persp.position.copy(_target).addScaledVector(_dir, d);
      this.persp.up.lerpVectors(UP_3D, UP_2D, p).normalize();
      this.persp.fov = fov;
      this.persp.updateProjectionMatrix();
      this.persp.lookAt(_target);
      onProgress(p);
    }, () => {
      // intercambio a ortográfica con el mismo encuadre
      this._orthoV = v1;
      this.ortho.position.copy(target1).addScaledVector(DOWN, 60000);
      this.ortho.zoom = 1;
      this.resize();
      this.ortho.lookAt(target1);
      this.controls2d.target.copy(target1);
      this.mode = '2d';
      this.controls2d.enabled = true;
      this.persp.up.copy(UP_3D);
    });
  }

  _to3d(onProgress) {
    this.transitioning = true;
    this.controls2d.enabled = false;

    // estado actual del plano (respetando pan/zoom del usuario)
    const target0 = this.controls2d.target.clone();
    const v0 = (this.ortho.top - this.ortho.bottom) / this.ortho.zoom * 1.0;

    const saved = this._saved3d || {
      target: this.schemCenter.clone(), dir: new THREE.Vector3(0.35, 0.9, 0.5).normalize(),
      v: this.schemV, fov: FOV_3D,
    };
    const qRot = new THREE.Quaternion().setFromUnitVectors(DOWN, saved.dir);

    // arrancar la perspectiva exactamente donde está la ortográfica
    this.mode = '3d';

    return this._run(1, 0, (p) => {
      // p va de 1 → 0 (blend hacia 3D)
      const t = 1 - p;
      const fov = THREE.MathUtils.lerp(FOV_MIN, saved.fov, t);
      const v = THREE.MathUtils.lerp(v0, saved.v, t);
      const d = v / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
      _q.identity().slerp(qRot, t);
      _dir.copy(DOWN).applyQuaternion(_q);
      _target.lerpVectors(target0, saved.target, t);
      this.persp.position.copy(_target).addScaledVector(_dir, d);
      this.persp.up.lerpVectors(UP_2D, UP_3D, t).normalize();
      this.persp.fov = fov;
      this.persp.updateProjectionMatrix();
      this.persp.lookAt(_target);
      onProgress(p);
    }, () => {
      this.controls3d.target.copy(saved.target);
      this.controls3d.enabled = true;
    });
  }

  _run(from, to, onUpdate, onDone) {
    const proxy = { p: from };
    onUpdate(from); // posicionar la cámara antes del primer frame del tween
    return gsap.to(proxy, {
      p: to,
      duration: dur(1.25),
      ease: 'power2.inOut',
      onUpdate: () => { this.blend = proxy.p; onUpdate(proxy.p); },
      onComplete: () => { this.blend = to; onDone(); this.transitioning = false; },
    });
  }
}

const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _target = new THREE.Vector3();
