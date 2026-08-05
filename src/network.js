// Capa de red: curvas de líneas (cintas), estaciones instanciadas y el morph
// geografía ↔ diagrama. Todo vive en UN solo renderer three.js.
//
// ESCALA: 1 unidad = 1 metro (el JSON ya viene en metros de la proyección
// local; ver tests/units.test.js). x = este, z = -norte (norte "arriba" en
// la vista cenital), y = altura. Las cintas/estaciones/trenes son de tamaño
// "maqueta" (decenas de metros) para leerse desde la órbita; la cabina los
// re-escala a proporciones reales.

import * as THREE from 'three';

const RIBBON_W = 110;   // ancho de cinta maqueta (m)
const BASE_Y = 24;      // elevación base de las líneas (m)
const LAYER_STEP = 11;  // separación vertical entre líneas (anti z-fight)
const STATION_Y = 120;

// ── Relieve vertical: la red NO es plana ──────────────────────────────────
//
// levels.txt da el nivel de cada andén (0 = calle). Es un ORDEN medido, no una
// profundidad: los −5 de U. de Chile L3 son cinco plantas, no cinco metros.
// Intenté derivar los metros de verdad sumando stair_count × huella por la
// cadena de escaleras, y no se puede: las transiciones de las estaciones
// profundas van servidas sólo por mecánicas y ascensores, que no declaran
// peldaños, así que la cadena se corta justo donde importaría.
//
// Así que la altura que se dibuja es ORDEN DE NIVEL × una constante, igual que
// las cintas de 110 m de ancho son vía de 6 m: maqueta legible desde la
// órbita. La constante no es inventada — 4,2 m es la mediana medida de 291
// saltos de un nivel con peldaños contados en el feed — pero va multiplicada
// por EXAGERACION para que un desnivel de cinco plantas se vea en una red de
// 20 km. El orden es dato; la separación, escala de maqueta.
// DOS ERRORES QUE COSTARON LA VISUALIZACIÓN, y por qué el código es así:
//
// 1. El relieve se dibuja HACIA ARRIBA desde el andén más profundo de la red,
//    no hacia abajo desde la calle. Con lo segundo, una línea a nivel −2
//    quedaba por debajo de la capa de ciudad y el suelo la tapaba entera: L1 y
//    L6 desaparecían al 100 %, L2 y L3 al 95 %. Sobrevivían sólo las que
//    tienen viaducto. El orden relativo entre niveles es el mismo; lo que
//    cambia es dónde se ancla el cero.
// 2. La exageración es modesta. La red abarca 8 niveles (−5 a +3) y los
//    tramos entre estaciones miden 600–2.000 m: a ×26 el peor tramo (Laguna
//    Sur→Barrancas, siete niveles en 1.080 m) daba 71 % de pendiente, y una
//    cinta así de inclinada se ve de canto. A ×4,5 el peor queda en ~12 %.
const NIVEL_M = 4.2;        // m por nivel (mediana medida de 291 escaleras)
const EXAGERACION = 4.5;    // ×: legible sin volver las cintas un tobogán
const NIVEL_Y = NIVEL_M * EXAGERACION;

// En cabina la exageración deja de valer: a ×26 el túnel bajaría al 11 % de
// pendiente sostenida y ningún metro pasa del 4 %. Dentro del tren se usan los
// metros de verdad, igual que las cintas se angostan a ancho de vía.
export const RELIEVE_REAL = 1 / EXAGERACION;

export class NetworkLayer {
  constructor(scene, data) {
    this.data = data;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.morph = 0; // 0 = geografía, 1 = diagrama
    this.widthScale = 1; // la cabina angosta las cintas a escala de vía
    this.relieve = 1;    // 0 = red plana (como era), 1 = niveles reales
    this.lines = new Map();
    this.active = new Map(); // lineId → bool (filtro)

    // suelo del relieve: el andén más profundo de toda la red. Todo se dibuja
    // hacia ARRIBA desde aquí, para que nada quede tapado por la capa de ciudad.
    this.nivelMin = 0;
    for (const st of Object.values(data.stations)) {
      for (const n of Object.values(st.in?.prof || {})) this.nivelMin = Math.min(this.nivelMin, n);
    }

    data.lines.forEach((line, idx) => this._buildLine(line, idx));
    this._buildStations();
    this.setMorph(0);
  }

  _buildLine(line, idx) {
    const N = line.path.length;
    const geo = new Float32Array(N * 2);
    const schem = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      geo[i * 2] = line.path[i][0];
      geo[i * 2 + 1] = -line.path[i][1];
      schem[i * 2] = line.schemPath[i][0];
      schem[i * 2 + 1] = -line.schemPath[i][1];
    }
    const cum = (pts) => {
      const c = new Float32Array(N);
      for (let i = 1; i < N; i++) {
        c[i] = c[i - 1] + Math.hypot(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]);
      }
      return c;
    };

    // geometría de cinta: 2 vértices por muestra, triángulos precalculados
    const positions = new Float32Array(N * 2 * 3);
    const indices = [];
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      indices.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(indices);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(line.color),
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1 + idx;
    this.group.add(mesh);

    const geoCum = cum(geo);
    this.lines.set(line.id, {
      def: line,
      N,
      geoPts: geo, schemPts: schem,
      geoCum, schemCum: cum(schem),
      blended: new Float32Array(N * 2),
      mesh,
      y: BASE_Y + idx * LAYER_STEP,
      // relieve: cota extra de cada muestra según el nivel de sus estaciones
      dy: this._perfilVertical(line, geoCum, N),
      color: new THREE.Color(line.color),
    });
    this.active.set(line.id, true);
  }

  /**
   * Cota extra (m) de cada muestra del trazado, interpolando entre el nivel de
   * una estación y el de la siguiente.
   *
   * La rampa entre dos estaciones es lineal porque el feed no dice cómo baja
   * la vía en medio: sabemos a qué nivel están los andenes, no el perfil del
   * túnel. Interpolar es la lectura más pobre posible de ese dato, que es
   * justamente la que no añade nada que no esté medido.
   */
  _perfilVertical(line, geoCum, N) {
    const dy = new Float32Array(N);
    const nivel = line.stations.map((id) => {
      const p = this.data.stations[id]?.in?.prof;
      return p && p[line.id] !== undefined ? p[line.id] : null;
    });
    if (!nivel.some((n) => n !== null)) return dy; // el feed no trae niveles
    // huecos: una estación sin nivel hereda el de la vecina conocida
    for (let i = 0; i < nivel.length; i++) if (nivel[i] === null) nivel[i] = 0;

    const sS = line.stationS;
    let k = 0;
    for (let i = 0; i < N; i++) {
      const s = geoCum[i];
      while (k < sS.length - 2 && s > sS[k + 1]) k++;
      const a = sS[k], b = sS[k + 1] ?? a;
      const t = b > a ? Math.min(1, Math.max(0, (s - a) / (b - a))) : 0;
      const n = nivel[k] + ((nivel[k + 1] ?? nivel[k]) - nivel[k]) * t;
      dy[i] = (n - this.nivelMin) * NIVEL_Y; // hacia arriba desde el más profundo
    }
    return dy;
  }

  _buildStations() {
    const ids = Object.keys(this.data.stations);
    this.stationIds = ids;
    const isXfer = (id) => this.data.stations[id].lines.length > 1;

    const dotGeo = new THREE.CylinderGeometry(75, 75, 50, 20);
    const ringGeo = new THREE.CylinderGeometry(150, 150, 30, 24);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x111114 });

    this.dots = new THREE.InstancedMesh(dotGeo, dotMat, ids.length);
    this.dots.renderOrder = 12;
    this.dots.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ids.length * 3).fill(1), 3);

    const xfers = ids.filter(isXfer);
    this.xferIds = xfers;
    this.rings = new THREE.InstancedMesh(ringGeo, ringMat, xfers.length);
    this.rings.renderOrder = 11;

    this.group.add(this.rings, this.dots);
    this._stationScale = ids.map((id) => (isXfer(id) ? 1.5 : 1));
    // cota de cada estación: su andén MENOS profundo (el más cercano a la calle)
    this._stationDy = ids.map((id) => {
      const p = this.data.stations[id]?.in?.prof;
      const niveles = p ? Object.values(p) : [];
      return niveles.length ? (Math.max(...niveles) - this.nivelMin) * NIVEL_Y : 0;
    });
    this._stationPos = new Map(); // id → Vector3 (posición actual blendeada)
    ids.forEach((id) => this._stationPos.set(id, new THREE.Vector3()));
  }

  /** m: 0 geografía → 1 diagrama. Actualiza cintas y estaciones. */
  setMorph(m) {
    this.morph = m;
    const halfW = RIBBON_W * this.widthScale * 0.5;
    const mtx = _mtx; // preasignada: setMorph corre por frame durante el morph
    // el relieve es geografía: el diagrama esquemático es plano por definición
    const relieve = (1 - m) * this.relieve;
    for (const L of this.lines.values()) {
      const { N, geoPts, schemPts, blended, dy } = L;
      for (let i = 0; i < N * 2; i++) blended[i] = geoPts[i] + (schemPts[i] - geoPts[i]) * m;
      const pos = L.mesh.geometry.attributes.position.array;
      for (let i = 0; i < N; i++) {
        const x = blended[i * 2], z = blended[i * 2 + 1];
        const y = L.y + dy[i] * relieve;
        const iP = Math.max(0, i - 1) * 2, iN = Math.min(N - 1, i + 1) * 2;
        let dx = blended[iN] - blended[iP], dz = blended[iN + 1] - blended[iP + 1];
        const len = Math.hypot(dx, dz) || 1e-9;
        dx /= len; dz /= len;
        const px = -dz * halfW, pz = dx * halfW;
        const o = i * 6;
        pos[o] = x - px; pos[o + 1] = y; pos[o + 2] = z - pz;
        pos[o + 3] = x + px; pos[o + 4] = y; pos[o + 5] = z + pz;
      }
      L.mesh.geometry.attributes.position.needsUpdate = true;
      L.mesh.geometry.computeBoundingSphere();
    }

    // estaciones
    this.stationIds.forEach((id, i) => {
      const st = this.data.stations[id];
      const x = st.geo[0] + (st.schem[0] - st.geo[0]) * m;
      const z = -(st.geo[1] + (st.schem[1] - st.geo[1]) * m);
      // la estación se posa sobre su andén más alto: en una combinación de dos
      // niveles el disco marca por dónde se entra, no el fondo del pozo
      const y = STATION_Y + this._stationDy[i] * relieve;
      this._stationPos.get(id).set(x, y, z);
      const s = this._stationScale[i];
      mtx.makeScale(s, 1, s).setPosition(x, y, z);
      this.dots.setMatrixAt(i, mtx);
    });
    this.xferIds.forEach((id, i) => {
      const p = this._stationPos.get(id);
      mtx.makeScale(1, 1, 1).setPosition(p.x, p.y - 20, p.z);
      this.rings.setMatrixAt(i, mtx);
    });
    this.dots.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
    this.dots.computeBoundingSphere();
  }

  /**
   * Punto sobre una línea: sGeo/sSchem son arcos (metros) en cada espacio;
   * se muestrea cada trazado por separado y se mezcla con el morph.
   * Devuelve posición a NIVEL DE VÍA (out.y = cota de la línea) y rumbo
   * (outDir, plano XZ); quien dibuje encima aplica su propia elevación.
   */
  pointAt(lineId, sGeo, sSchem, out, outDir) {
    const L = this.lines.get(lineId);
    const m = this.morph;
    const gx = sampleArc(L.geoPts, L.geoCum, sGeo, _pA);
    const sx = sampleArc(L.schemPts, L.schemCum, sSchem, _pB);
    out.set(
      gx[0] + (sx[0] - gx[0]) * m,
      // el tren va sobre la vía, y la vía sube y baja con el nivel del andén
      L.y + this.alturaEn(lineId, sGeo),
      gx[1] + (sx[1] - gx[1]) * m,
    );
    if (outDir) {
      const g2 = sampleArc(L.geoPts, L.geoCum, sGeo + 30, _pC);
      const s2 = sampleArc(L.schemPts, L.schemCum, sSchem + 30, _pD);
      outDir.set(
        (g2[0] + (s2[0] - g2[0]) * m) - out.x,
        0,
        (g2[1] + (s2[1] - g2[1]) * m) - out.z,
      );
      if (outDir.lengthSq() < 1e-12) outDir.set(1, 0, 0);
      outDir.normalize();
    }
    return out;
  }

  /**
   * Cota extra (m) de una línea a un arco geográfico dado, ya atenuada por el
   * morph. Es la misma curva que dibujan las cintas, así que un tren muestreado
   * aquí va exactamente sobre su vía y no flotando ni enterrado.
   */
  alturaEn(lineId, sGeo) {
    const L = this.lines.get(lineId);
    if (!L || !L.dy) return 0;
    const relieve = (1 - this.morph) * this.relieve;
    if (!relieve) return 0;
    const { geoCum, dy, N } = L;
    const s = Math.max(0, Math.min(geoCum[N - 1], sGeo));
    let lo = 0, hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (geoCum[mid] < s) lo = mid + 1; else hi = mid;
    }
    const i = Math.max(1, lo);
    const seg = geoCum[i] - geoCum[i - 1] || 1e-9;
    const t = (s - geoCum[i - 1]) / seg;
    return (dy[i - 1] + (dy[i] - dy[i - 1]) * t) * relieve;
  }

  stationPosition(id) { return this._stationPos.get(id); }

  lineColor(id) { return this.lines.get(id).color; }

  isActive(id) { return this.active.get(id); }

  // ── estado real: líneas suspendidas/parciales y estaciones cerradas ──────
  /** status: 'normal' | 'partial' | 'suspended'. El pulso lo anima main. */
  setLineStatus(id, status) {
    const L = this.lines.get(id);
    if (!L) return;
    L.status = status;
    if (status === 'suspended') {
      L.mesh.material.color.setHex(0x5a5a64); // gris con pulso de alerta
    } else if (status === 'partial') {
      L.mesh.material.color.copy(L.color).multiplyScalar(0.55);
    } else {
      L.mesh.material.color.copy(L.color);
    }
  }

  lineStatus(id) { return this.lines.get(id)?.status || 'normal'; }

  /** Pulso de alerta para líneas suspendidas (llamar por frame con el reloj). */
  pulseSuspended(nowS) {
    const k = 0.45 + 0.2 * Math.sin(nowS * 2.6);
    for (const [id, L] of this.lines) {
      if (L.status === 'suspended') {
        L.mesh.material.opacity = (this.active.get(id) ? 1 : 0.06) * (this._dim ?? 1) * k;
      }
    }
  }

  /** Estaciones cerradas: disco atenuado (placa gris vía tooltip). */
  setClosedStations(ids) {
    this.closedSet = new Set(ids);
    this._refreshDots();
  }

  _refreshDots() {
    const c = new THREE.Color();
    this.stationIds.forEach((sid, i) => {
      const st = this.data.stations[sid];
      const anyOn = st.lines.some((l) => this.active.get(l));
      const closed = this.closedSet?.has(sid);
      c.setScalar(closed ? 0.28 : anyOn ? 1 : 0.18);
      this.dots.setColorAt(i, c);
    });
    this.dots.instanceColor.needsUpdate = true;
  }

  /**
   * Muestra u oculta las CINTAS de línea sin tocar las estaciones. En modo
   * buses las líneas del metro desaparecen del todo (dos redes superpuestas
   * no se leen); los discos de estación se quedan como referencia urbana.
   */
  setRibbonsVisible(on) {
    for (const L of this.lines.values()) L.mesh.visible = on;
  }

  /**
   * Atenúa los discos de estación (el modo buses manda el metro al fondo).
   * Separado de setGlobalDim porque éste sólo gobierna las cintas.
   */
  dimStations(k) {
    for (const m of [this.dots.material, this.rings.material]) {
      m.transparent = k < 1;
      m.opacity = k;
    }
  }

  /** Atenuación global de cintas (la cabina baja el brillo del piso). */
  setGlobalDim(k) {
    this._dim = k;
    for (const [id, L] of this.lines) {
      L.mesh.material.opacity = (this.active.get(id) ? 1 : 0.06) * k;
    }
  }

  setLineActive(id, on) {
    this.active.set(id, on);
    const L = this.lines.get(id);
    L.mesh.material.opacity = (on ? 1 : 0.06) * (this._dim ?? 1);
    // una estación se apaga solo si TODAS sus líneas están apagadas
    this._refreshDots();
  }
}

const _pA = [0, 0], _pB = [0, 0], _pC = [0, 0], _pD = [0, 0];
const _mtx = new THREE.Matrix4();

function sampleArc(pts, cum, s, out) {
  const n = cum.length;
  const total = cum[n - 1];
  s = Math.max(0, Math.min(total, s));
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < s) lo = mid + 1; else hi = mid;
  }
  const i = Math.max(1, lo);
  const seg = cum[i] - cum[i - 1] || 1e-9;
  const f = (s - cum[i - 1]) / seg;
  out[0] = pts[(i - 1) * 2] + (pts[i * 2] - pts[(i - 1) * 2]) * f;
  out[1] = pts[(i - 1) * 2 + 1] + (pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]) * f;
  return out;
}
