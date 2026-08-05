// Modo flota: la red de recorridos de RED como mapa base y todos los buses
// medidos encima. El análogo urbano de la capa de metro — pero al revés en
// jerarquía visual, porque el estrato de dato es el opuesto:
//
//   · la RED (718 trazados oficiales del DTPM) se dibuja tenue y estable:
//     es geometría verificada (los GPS reales caen sobre ella, mediana 3 m);
//   · cada BUS es una medición con SU PROPIA hora. La edad se dibuja: un bus
//     recién medido brilla; uno de hace 5 minutos se apaga hacia gris. Nada
//     se anima entre mediciones — un salto honesto vale más que un deslizar
//     inventado. El único movimiento continuo es un fundido corto de opacidad
//     al llegar una foto nueva, que es presentación, no posición.
//
// Presupuesto: 718 trazados ≈ 92.700 puntos → UN LineSegments (1 draw call).
// ~5.000 buses → UN InstancedMesh (1 draw call). Total del modo: 2 draw calls.

import * as THREE from 'three';
import { decodePolyline } from './placement.js';

const RED_Y = 14;          // bajo las cintas del metro (BASE_Y = 24)
const BUS_Y = 60;
const BUS_R = 34;          // radio maqueta: legible desde la órbita
const CAPACITY = 6500;     // flota medida (~4.500 reales)
const SIM_CAPACITY = 9000; // flota simulada (pico estimado ~5.000; margen)
const FRESCO_S = 90;       // hasta aquí el bus se considera "al día"
const VIEJO_S = 420;       // desde aquí queda al mínimo de brillo
const AMBAR = 0xffb000;    // simulado = ámbar (como el LED); medido = cian

const M_PER_DEG_LAT = 110540;

export class FleetLayer {
  constructor(scene, projection) {
    this.lat0 = projection.lat0;
    this.lon0 = projection.lon0;
    this.mPerDegLon = 111320 * Math.cos((projection.lat0 * Math.PI) / 180);

    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this._fade = 1;
    this.visible = false;

    // ── flota instanciada ──
    const geo = new THREE.SphereGeometry(BUS_R, 8, 6);
    geo.scale(1, 0.55, 1); // lenteja: se lee como punto desde arriba y desde la órbita
    this.buses = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false }),
      CAPACITY,
    );
    this.buses.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.buses.renderOrder = 19;
    this.buses.frustumCulled = false;
    this.group.add(this.buses);

    // ── anillo del bus seleccionado ──
    this.sel = new THREE.Mesh(
      new THREE.RingGeometry(70, 95, 24),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    this.sel.rotation.x = -Math.PI / 2;
    this.sel.renderOrder = 21;
    this.sel.visible = false;
    this.group.add(this.sel);

    // ── flota SIMULADA (itinerario oficial): ámbar, en movimiento continuo ──
    // Simulado = punto nítido que se mueve suave (es una ficción matemática
    // limpia, como los trenes). Medido = punto que envejece y salta. Los dos
    // estratos nunca comparten color.
    const simGeo = new THREE.SphereGeometry(BUS_R * 0.85, 6, 4);
    simGeo.scale(1, 0.55, 1);
    this.sim = new THREE.InstancedMesh(
      simGeo,
      new THREE.MeshBasicMaterial({ color: AMBAR, transparent: true, opacity: 0.92, toneMapped: false, depthWrite: false }),
      SIM_CAPACITY,
    );
    this.sim.renderOrder = 19;
    this.sim.frustumCulled = false;
    this.sim.visible = false;
    this.group.add(this.sim);
    this._simX = new Float64Array(SIM_CAPACITY);
    this._simZ = new Float64Array(SIM_CAPACITY);
    this._simMeta = new Array(SIM_CAPACITY).fill(null); // {key, route, dir}
    this._simLastW = 0;
    this.simCount = 0;
    this.simDropped = 0;

    this.red = null;            // LineSegments de la red, construido una vez
    this._plates = [];          // índice de instancia → patente
    this._pos = [];             // índice → {x, z} para el picking
    this._data = new Map();     // patente → bus (última foto)
    this._recibidoEn = 0;       // Date.now() de la última foto buena
    this._m = new THREE.Matrix4();
    this._c = new THREE.Color();
    this.count = 0;
    this.dropped = 0;           // buses que no cupieron: se EXPONE, no se calla
    this.fuente = 'sim';        // 'sim' (itinerario) | 'avl' (GPS medido)
    this.setFuente(this.fuente);
  }

  /** Cambia la fuente visible: itinerario simulado o mediciones GPS. */
  setFuente(f) {
    this.fuente = f;
    if (this._cab) return; // en cabina no se muestra ninguna de las dos
    this.sim.visible = f === 'sim';
    this.buses.visible = f === 'avl';
    this.sel.visible = false;
  }

  /**
   * Modo cabina: toda esta capa es maqueta sobredimensionada (buses de 34 m
   * de radio, red flotando a 14 m). Dentro de un bus, a escala real, estorba:
   * se apaga entera y BusCab dibuja la calle y los vecinos a tamaño de verdad.
   */
  setCabMode(on) {
    this._cab = on;
    this.sim.visible = !on && this.fuente === 'sim';
    this.buses.visible = !on && this.fuente === 'avl';
    if (this.red) this.red.visible = !on;
    if (on) this.sel.visible = false;
  }

  /**
   * Reposiciona la flota simulada (llamar por frame; el movimiento continuo
   * es legítimo aquí porque la posición ES una función continua del tiempo).
   * @param lista  buses de BusSim.update()
   * @param puntoEn (shapeId, s) → {x, z} — normalmente placer.puntoEn
   * @param selKey  key del bus seleccionado (para mover el anillo con él)
   */
  setSim(lista, puntoEn, selKey = null) {
    let w = 0;
    let selPos = null;
    this.simDropped = 0;
    for (const b of lista) {
      if (w >= SIM_CAPACITY) { this.simDropped++; continue; }
      const p = puntoEn(b.shape, b.s);
      if (!p) continue;
      this._m.makeTranslation(p.x, BUS_Y, p.z);
      this.sim.setMatrixAt(w, this._m);
      this._simX[w] = p.x; this._simZ[w] = p.z;
      const meta = this._simMeta[w] || (this._simMeta[w] = {});
      meta.key = b.key; meta.route = b.route; meta.dir = b.dir;
      if (selKey && b.key === selKey) selPos = { x: p.x, z: p.z };
      w++;
    }
    for (let i = w; i < this._simLastW; i++) this.sim.setMatrixAt(i, _hide);
    this._simLastW = w;
    this.simCount = w;
    this.sim.count = Math.max(w, 1);
    this.sim.instanceMatrix.needsUpdate = true;
    if (selKey) {
      if (selPos) { this.sel.position.set(selPos.x, BUS_Y + 8, selPos.z); this.sel.visible = true; }
      else this.sel.visible = false; // el bus seleccionado llegó al terminal
    }
    return selPos;
  }

  /** Bus SIMULADO más cercano a un punto de la escena. */
  cercanoSim(x, z, radio = 300) {
    let best = -1, bestD = radio * radio;
    for (let i = 0; i < this.simCount; i++) {
      const dx = this._simX[i] - x, dz = this._simZ[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    const m = this._simMeta[best];
    return { sim: true, key: m.key, route: m.route, dir: m.dir, x: this._simX[best], z: this._simZ[best] };
  }

  proyectar(lon, lat) {
    return {
      x: (lon - this.lon0) * this.mPerDegLon,
      z: -((lat - this.lat0) * M_PER_DEG_LAT),
    };
  }

  /** Construye la red de recorridos una sola vez a partir de shapes.json. */
  construirRed(shapes) {
    if (this.red) return;
    let totalSegs = 0;
    const decoded = [];
    for (const enc of Object.values(shapes)) {
      const pts = decodePolyline(enc);
      if (pts.length > 1) { decoded.push(pts); totalSegs += pts.length - 1; }
    }
    const pos = new Float32Array(totalSegs * 2 * 3);
    let w = 0;
    for (const pts of decoded) {
      let prev = this.proyectar(pts[0][1], pts[0][0]);
      for (let i = 1; i < pts.length; i++) {
        const cur = this.proyectar(pts[i][1], pts[i][0]);
        pos[w++] = prev.x; pos[w++] = RED_Y; pos[w++] = prev.z;
        pos[w++] = cur.x; pos[w++] = RED_Y; pos[w++] = cur.z;
        prev = cur;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.red = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: 0x2a6a7d, transparent: true, opacity: 0.34, depthWrite: false }),
    );
    this.red.renderOrder = 6;
    this.red.frustumCulled = false;
    this.group.add(this.red);
  }

  /** Nueva foto de la flota. Se redibuja todo; no hay estado intermedio. */
  setFlota(busMap, fetchedAtWall) {
    this._data = busMap;
    this._recibidoEn = fetchedAtWall;
    this._plates.length = 0;
    this._pos.length = 0;
    let wIdx = 0;
    this.dropped = 0;

    for (const [plate, b] of busMap) {
      if (wIdx >= CAPACITY) { this.dropped++; continue; }
      const p = this.proyectar(b.lon, b.lat);
      this._m.makeTranslation(p.x, BUS_Y, p.z);
      this.buses.setMatrixAt(wIdx, this._m);
      this._tint(wIdx, b, fetchedAtWall);
      this._plates.push(plate);
      this._pos.push(p);
      wIdx++;
    }
    for (let i = wIdx; i < this.buses.count; i++) this.buses.setMatrixAt(i, _hide);
    this.count = wIdx;
    this.buses.count = Math.max(wIdx, 1);
    this.buses.instanceMatrix.needsUpdate = true;
    this.buses.instanceColor.needsUpdate = true;
  }

  /** Color por edad de la MEDICIÓN de ese bus (no de la descarga). */
  _tint(i, b, ahora) {
    const edad = Math.max(0, (ahora - b.ts) / 1000);
    // 0 s → cian brillante · 90 s → cian medio · 420 s+ → gris apagado
    const k = edad <= FRESCO_S ? 1 : edad >= VIEJO_S ? 0 : 1 - (edad - FRESCO_S) / (VIEJO_S - FRESCO_S);
    this._c.setRGB(
      0.12 + (0.0 - 0.12) * k + 0.0,        // r: gris → nada
      0.16 + (0.90 - 0.16) * k,             // g
      0.20 + (1.0 - 0.20) * k,              // b
    );
    this.buses.setColorAt(i, this._c);
  }

  /** Reaplica el tinte por edad (llamar ~cada segundo: los buses envejecen solos). */
  envejecer() {
    if (!this.count) return;
    const ahora = Date.now();
    let i = 0;
    for (const plate of this._plates) {
      const b = this._data.get(plate);
      if (b) this._tint(i, b, ahora);
      i++;
    }
    this.buses.instanceColor.needsUpdate = true;
  }

  /** Bus más cercano a un punto de la escena (picking). Lineal: 5.000 es barato. */
  cercano(x, z, radio = 300) {
    let best = -1, bestD = radio * radio;
    for (let i = 0; i < this._pos.length; i++) {
      const dx = this._pos[i].x - x, dz = this._pos[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    const plate = this._plates[best];
    return { plate, bus: this._data.get(plate), x: this._pos[best].x, z: this._pos[best].z };
  }

  seleccionar(hit) {
    if (!hit) { this.sel.visible = false; return; }
    this.sel.position.set(hit.x, BUS_Y + 8, hit.z);
    this.sel.visible = true;
  }

  /** Posición actual de una patente en la última foto (o null). */
  posicionDe(plate) {
    const b = this._data.get(plate);
    return b ? { ...this.proyectar(b.lon, b.lat), bus: b } : null;
  }

  get edadFotoS() { return this._recibidoEn ? (Date.now() - this._recibidoEn) / 1000 : null; }

  setVisible(on) { this.visible = on; this.group.visible = on && this._fade > 0.02; }

  /** La flota es geografía: se apaga al pasar al diagrama esquemático. */
  setFade(f) {
    this._fade = f;
    this.buses.material.opacity = f;
    this.sim.material.opacity = 0.92 * f;
    if (this.red) this.red.material.opacity = 0.34 * f;
    this.group.visible = this.visible && f > 0.02;
  }
}

const _hide = new THREE.Matrix4().makeScale(0, 0, 0);
