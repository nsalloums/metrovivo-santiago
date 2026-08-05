// Simulación de la flota de buses: posiciones = f(hora oficial), igual que
// el metro. Función PURA — sin red, sin DOM, sin three.js — y determinista:
// dos pestañas a la misma hora muestran exactamente los mismos buses.
//
// EL MODELO
// Cada (servicio, sentido) tiene en data/bus/patterns.json:
//   freq · ventanas [inicio, fin, headway] por tipo de día, derivadas de
//          frequencies.txt tomando el calendario DOMINANTE del día (la
//          lección del metro: sumar calendarios paralelos parte el intervalo)
//   sec  · hora de paso por CADA paradero como offset desde la salida
//          (deltas; vienen de stop_times.txt del viaje representativo)
//   arc  · posición de cada paradero sobre el trazado (deltas, metros)
//
// Un bus que salió en d está, en el instante t, en el tramo j tal que
// sec[j] ≤ t−d ≤ sec[j+1], interpolando arco linealmente entre paraderos.
// La velocidad entre cada par de paraderos es la del itinerario real: el
// perfil de marcha (rápido en avenida, lento en zona de paradas densas) sale
// de los datos, no de una constante.
//
// QUÉ ES Y QUÉ NO ES
// Esto es la MISMA clase de dato que los trenes de metrovivo: dónde DEBERÍA
// estar cada bus según el itinerario oficial, no dónde está. Para posiciones
// medidas está el sub-modo GPS (fleet-client). Los dos estratos no comparten
// color ni forma en pantalla.

export class BusSim {
  /** @param patterns data/bus/patterns.json (con sec y freq por patrón) */
  constructor(patterns) {
    this.patterns = [];
    this.byRD = new Map(); // 'ruta|sentido' → patrón, para resolver una key sola
    for (const [route, dirs] of Object.entries(patterns.patterns)) {
      for (const dir of ['I', 'R']) {
        const p = dirs[dir];
        if (!p || !p.sec || p.sec.length < 2) continue;
        // acumular deltas una sola vez
        const n = p.sec.length;
        const sec = new Float64Array(n), arc = new Float64Array(n);
        let sAcc = 0, aAcc = 0;
        for (let i = 0; i < n; i++) {
          sAcc += p.sec[i]; sec[i] = sAcc;
          aAcc += p.arc[i]; arc[i] = aAcc;
        }
        const P = {
          route, dir, shape: p.shape,
          sec, arc,
          st: p.st,                 // índices de paradero en el catálogo
          T: sec[n - 1],            // duración total del viaje (s)
          freq: p.freq || { wd: [], sa: [], su: [] },
        };
        this.patterns.push(P);
        this.byRD.set(`${route}|${dir}`, P);
      }
    }
    // pool de resultados reutilizado por frame (mismo patrón que sim.js)
    this._pool = [];
    this.buses = [];
  }

  /**
   * Posiciones de todos los buses en circulación en el instante `sec` del
   * tipo de día `day`. Devuelve un array reutilizado internamente: consumir
   * en el frame, no retener referencias.
   * Bus: { key, route, dir, shape, s, frac }
   *   s    · arco sobre el trazado (m)
   *   frac · avance 0..1 del viaje (para depurar/atenuar cerca del terminal)
   */
  update(sec, day) {
    let w = 0;
    for (const P of this.patterns) {
      const bands = P.freq[day] || [];
      for (const [a, b, h] of bands) {
        if (!(h > 0)) continue;
        // salidas activas de esta ventana: las que ya partieron (d ≤ sec) y
        // aún no terminaron (sec ≤ d + T). k es el índice de salida.
        const kMin = Math.max(0, Math.ceil((sec - P.T - a) / h));
        const kMax = Math.min(Math.floor((b - 1 - a) / h), Math.floor((sec - a) / h));
        for (let k = kMin; k <= kMax; k++) {
          const e = sec - (a + k * h); // segundos desde la salida
          if (e < 0 || e > P.T) continue;
          const bus = this._pool[w] || (this._pool[w] = {});
          bus.key = `${P.route}|${P.dir}|${a}|${k}`;
          bus.route = P.route;
          bus.dir = P.dir;
          bus.shape = P.shape;
          bus.s = arcAt(P, e);
          bus.frac = e / P.T;
          w++;
        }
      }
    }
    this._pool.length = Math.max(this._pool.length, w);
    this.buses = this._pool.slice(0, w);
    return this.buses;
  }

  /**
   * Estado completo de UN bus, resuelto desde su key sin recorrer la flota.
   * Es lo que hace posible viajar dentro de él: cada frame se vuelve a
   * PREGUNTAR dónde está a la hora actual, en vez de integrar una velocidad.
   * Si el reloj se mueve (scrubbing, ×60), el bus salta con él sin derivar.
   *
   * → null cuando a esa hora ese bus no circula: aún no sale, ya llegó al
   *   terminal, o su ventana de frecuencia no existe ese tipo de día.
   */
  estadoDe(key, sec, day) {
    const p = String(key).split('|');
    if (p.length !== 4) return null;
    const P = this.byRD.get(`${p[0]}|${p[1]}`);
    if (!P) return null;
    const a = +p[2], k = +p[3];
    const banda = (P.freq[day] || []).find((b) => b[0] === a);
    if (!banda) return null;
    const e = sec - (a + k * banda[2]);
    if (e < 0 || e > P.T) return null;

    const i = idxAt(P.sec, e);
    const dt = P.sec[i] - P.sec[i - 1] || 1e-9;
    const f = (e - P.sec[i - 1]) / dt;
    return {
      key, route: P.route, dir: P.dir, shape: P.shape,
      s: P.arc[i - 1] + (P.arc[i] - P.arc[i - 1]) * f,
      e, T: P.T, frac: e / P.T,
      // velocidad DEL TRAMO según el itinerario (m/s): constante entre dos
      // paraderos porque es exactamente lo que el horario declara
      v: (P.arc[i] - P.arc[i - 1]) / dt,
      nextStop: P.st[i],
      etaNext: P.sec[i] - e,
      destStop: P.st[P.st.length - 1],
      restantes: P.st.length - i,
      totalStops: P.st.length,
    };
  }

  /** Cuántos buses habría en circulación a esa hora (sin construir el array). */
  count(sec, day) {
    let n = 0;
    for (const P of this.patterns) {
      for (const [a, b, h] of P.freq[day] || []) {
        if (!(h > 0)) continue;
        const kMin = Math.max(0, Math.ceil((sec - P.T - a) / h));
        const kMax = Math.min(Math.floor((b - 1 - a) / h), Math.floor((sec - a) / h));
        if (kMax >= kMin) n += kMax - kMin + 1;
      }
    }
    return n;
  }
}

/** Índice i tal que sec[i-1] ≤ e ≤ sec[i] (el tramo entre dos paraderos). */
function idxAt(sec, e) {
  let lo = 0, hi = sec.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sec[mid] < e) lo = mid + 1; else hi = mid;
  }
  return Math.max(1, lo);
}

/** Arco (m) sobre el trazado a `e` segundos de la salida: interpola el itinerario. */
function arcAt(P, e) {
  const { sec, arc } = P;
  const n = sec.length;
  if (e <= sec[0]) return arc[0];
  if (e >= sec[n - 1]) return arc[n - 1];
  const i = idxAt(sec, e);
  const dt = sec[i] - sec[i - 1] || 1e-9;
  const f = (e - sec[i - 1]) / dt;
  return arc[i - 1] + (arc[i] - arc[i - 1]) * f;
}
