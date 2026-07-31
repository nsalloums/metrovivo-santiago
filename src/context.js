// Contexto urbano dibujado como geometría propia (sin mapas ni tiles):
// suelo de maqueta, río Mapocho como trazo sutil y grilla urbana tenue.
// Todo se desvanece al pasar al plano esquemático. Unidades: metros.

import * as THREE from 'three';

export class ContextLayer {
  constructor(scene, data) {
    this.group = new THREE.Group();
    scene.add(this.group);

    const [minX, minY, maxX, maxY] = data.bbox;
    const w = maxX - minX, h = maxY - minY;
    const cx = (minX + maxX) / 2, cz = -(minY + maxY) / 2;
    const M = 6000; // margen (m)

    // suelo
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(w + M * 2, h + M * 2),
      new THREE.MeshBasicMaterial({ color: 0x101014 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, -20, cz);
    this.group.add(ground);

    // grilla urbana tenue (cada 1 km)
    const pts = [];
    const K = 1000;
    const x0 = Math.ceil((cx - w / 2 - M) / K) * K, x1 = Math.floor((cx + w / 2 + M) / K) * K;
    const z0 = Math.ceil((cz - h / 2 - M) / K) * K, z1 = Math.floor((cz + h / 2 + M) / K) * K;
    for (let x = x0; x <= x1; x += K) pts.push(x, 0, z0, x, 0, z1);
    for (let z = z0; z <= z1; z += K) pts.push(x0, 0, z, x1, 0, z);
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.grid = new THREE.LineSegments(
      gridGeo,
      new THREE.LineBasicMaterial({ color: 0x1e1e26, transparent: true, opacity: 0.5 }),
    );
    this.grid.position.y = -8;
    this.group.add(this.grid);

    // río Mapocho: cinta ancha y oscura
    this.river = this._ribbon(data.river, 240, 0x1c2c3d, 4);
    this.group.add(this.river);
  }

  _ribbon(path, width, color, y) {
    const N = path.length;
    const pos = new Float32Array(N * 2 * 3);
    const idx = [];
    for (let i = 0; i < N; i++) {
      const x = path[i][0], z = -path[i][1];
      const iP = Math.max(0, i - 1), iN = Math.min(N - 1, i + 1);
      let dx = path[iN][0] - path[iP][0];
      let dz = -path[iN][1] + path[iP][1];
      const l = Math.hypot(dx, dz) || 1e-9;
      dx /= l; dz /= l;
      const px = (-dz * width) / 2, pz = (dx * width) / 2;
      pos.set([x - px, y, z - pz, x + px, y, z + pz], i * 6);
      if (i < N - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, depthWrite: false,
    }));
  }

  /** fade: 1 = visible (geografía), 0 = oculto (diagrama). */
  setFade(f) {
    this.grid.material.opacity = 0.5 * f;
    this.river.material.opacity = 0.9 * f;
    this.grid.visible = f > 0.02;
    this.river.visible = f > 0.02;
  }
}
