// Motor de simulación: la posición de cada tren es función determinista de la
// hora en America/Santiago. Por línea y sentido se generan "trenes virtuales"
// que parten del terminal según la frecuencia vigente y pausan ~20 s en cada
// parada de su patrón.
//
// PATRONES DE PARADA: cada línea tiene N patrones — C (común, todas las
// estaciones) y, si hay operación expresa, R (Ruta Roja) y V (Ruta Verde),
// que solo se detienen en sus estaciones + las comunes. Durante las ventanas
// expresas los trenes nuevos se generan alternando R/V (o con los headways
// por variante si el feed los trae); los que están en viaje completan su
// patrón. El perfil trapezoidal se calcula entre PARADAS del patrón, así un
// expreso cruza las estaciones saltadas a velocidad de crucero sin frenar,
// con llegada puntual como siempre.

import { hhmmToSec } from './time.js';

const CRUISE = 13.9;   // m/s de media programada entre paradas (~50 km/h)
const DWELL = 20;      // s de detención en cada parada
const MIN_SEG = 45;    // s mínimos entre paradas
const ACCEL = 1.0;     // m/s² de aceleración/frenado nominal
const VMAX = 80 / 3.6; // clamp de crucero: 80 km/h

/**
 * Perfil de velocidad trapezoidal para un tramo: acelerar (a) → crucero (v)
 * → frenar (a), calculado para cubrir EXACTAMENTE D metros en T segundos
 * (llegada puntual). De vT − v²/a = D sale v = (aT − √((aT)² − 4aD)) / 2.
 * Si a=1 m/s² no alcanza (tramo corto/rápido), se sube a; si v excede el
 * clamp de 80 km/h, se fija v y se recalcula a = v²/(vT − D).
 */
export function trapezoidProfile(D, T) {
  let a = ACCEL;
  if ((a * T * T) / 4 <= D * 1.02) a = (4.08 * D) / (T * T);
  const disc = Math.max(0, a * T * a * T - 4 * a * D);
  let v = (a * T - Math.sqrt(disc)) / 2;
  if (v > VMAX) {
    v = VMAX;
    a = (v * v) / (v * T - D); // vT > D porque v > velocidad media
  }
  return { a, v, t1: v / a };
}

/** Distancia recorrida a los τ segundos del perfil (0 ≤ τ ≤ T). */
export function profileDist(p, tau, T, D) {
  if (tau <= 0) return 0;
  if (tau >= T) return D;
  if (tau < p.t1) return 0.5 * p.a * tau * tau;
  if (tau <= T - p.t1) return 0.5 * p.a * p.t1 * p.t1 + p.v * (tau - p.t1);
  const r = T - tau;
  return D - 0.5 * p.a * r * r;
}

/** Velocidad instantánea (m/s) a los τ segundos del perfil. */
export function profileVel(p, tau, T) {
  if (tau <= 0 || tau >= T) return 0;
  return Math.min(p.a * tau, p.v, p.a * (T - tau));
}

export class Simulation {
  constructor(data) {
    this.data = data;
    this.lines = data.lines.map((line) => {
      const S = line.stationS;

      // un patrón = lista de índices globales de sus paradas + horario/perfil
      const mkPattern = (id, stopIds) => {
        const stops = stopIds.map((sid) => line.stations.indexOf(sid));
        const segT = [], prof = [];
        for (let k = 0; k < stops.length - 1; k++) {
          const D = S[stops[k + 1]] - S[stops[k]];
          const T = Math.max(MIN_SEG, D / CRUISE);
          segT.push(T);
          prof.push(trapezoidProfile(D, T));
        }
        const sched = (times) => {
          const arr = [0], dep = [0];
          for (let i = 0; i < times.length; i++) {
            arr.push(dep[i] + times[i]);
            dep.push(arr[i + 1] + (i < times.length - 1 ? DWELL : 0));
          }
          return { arr, dep };
        };
        return {
          id, stops, prof,
          stopSet: new Set(stops),
          sched: [sched(segT), sched([...segT].reverse())],
          trip: segT.reduce((a, b) => a + b, 0) + (stops.length - 2) * DWELL,
        };
      };

      const pat = { C: mkPattern('C', line.stations) };
      if (line.express?.patterns?.R) pat.R = mkPattern('R', line.express.patterns.R);
      if (line.express?.patterns?.V) pat.V = mkPattern('V', line.express.patterns.V);

      // ventanas expresas en segundos por tipo de día
      const expWin = { wd: [], sa: [], su: [] };
      if (line.express) {
        for (const d of ['wd', 'sa', 'su']) {
          expWin[d] = (line.express.windows?.[d] || []).map(([a, b]) => [hhmmToSec(a), hhmmToSec(b)]);
        }
      }

      const L = {
        def: line,
        n: line.stations.length,
        pat, expWin,
        maxTrip: Math.max(...Object.values(pat).map((p) => p.trip)),
        departures: {}, // cacheKey → {times[], pats[]}
        episodes: [],   // contingencias: [{mode, from, to, closed[], ranges[]}]
        ov: null,       // episodio vigente (o null = normal)
        _mk: mkPattern, // para patrones dinámicos de contingencia
      };
      // compat: el patrón común expone la API previa (tests, auditoría)
      L.sched = pat.C.sched;
      L.prof = pat.C.prof;
      L.trip = pat.C.trip;
      return L;
    });
    this.byId = new Map(this.lines.map((l) => [l.def.id, l]));
    this.trains = [];
    this.byKey = new Map(); // key estable → tren (para estelas y cabina)
    this.ovVersion = 0;     // invalida el caché de salidas al cambiar el estado
  }

  // ── contingencias de la red (overlay de servicio) ────────────────────────
  /**
   * Aplica un escenario de contingencia (src/scenarios.js) a la simulación.
   * @param sec instante simulado en que rige el cambio; 0 = preexistente
   *   (al cargar la página con una contingencia ya en curso).
   * Reglas: los trenes en viaje frenan en su próxima parada y quedan
   * atenuados (cero teleports); las salidas dentro del episodio se
   * suprimen (suspensión) o se reemplazan por patrones de contingencia
   * (tramos abiertos con turnback / paso directo por estación cerrada); al
   * restablecerse, la reintroducción es gradual: solo spawnea lo que el
   * horario genera desde ese momento.
   */
  applyEstado(state, sec) {
    let changed = false;
    for (const L of this.lines) {
      const target = this._targetOverlay(L, state?.lines?.[L.def.id]);
      const curSig = L.ov?.sig || '';
      const newSig = target?.sig || '';
      if (curSig === newSig) continue;
      changed = true;
      if (L.ov) L.ov.to = sec; // cerrar el episodio vigente
      if (target) {
        L.ov = { ...target, from: sec, to: null };
        L.episodes.push(L.ov);
      } else {
        L.ov = null;
      }
    }
    if (changed) this.ovVersion++;
    return changed;
  }

  _targetOverlay(L, st) {
    if (!st || st.status === 'normal') return null;
    if (st.status === 'suspended') return { mode: 'suspended', sig: 'S' };
    const closed = (st.closedStations || [])
      .map((id) => L.def.stations.indexOf(id))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    if (!closed.length) return { mode: 'notice', sig: 'N' }; // aviso sin efecto físico
    // rachas contiguas ≥2 → cierre de tramo; sueltas → paso directo
    const ranges = [];
    let run = [closed[0]];
    for (let i = 1; i < closed.length; i++) {
      if (closed[i] === run[run.length - 1] + 1) run.push(closed[i]);
      else { if (run.length >= 2) ranges.push([run[0], run[run.length - 1]]); run = [closed[i]]; }
    }
    if (run.length >= 2) ranges.push([run[0], run[run.length - 1]]);
    return { mode: 'closure', closed, ranges, sig: `C${closed.join('.')}` };
  }

  /** Patrones de contingencia de un episodio (tramos abiertos / paso directo). */
  _epPatterns(L, ep) {
    if (ep.pats) return ep.pats;
    const ids = L.def.stations;
    const closedSet = new Set(ep.closed);
    const pats = [];
    if (ep.ranges.length) {
      // sub-líneas en los tramos abiertos, con turnback en las fronteras
      const open = [];
      let start = 0;
      for (const [a, b] of ep.ranges) {
        if (a - 1 >= start) open.push([start, a - 1]);
        start = b + 1;
      }
      if (start <= ids.length - 1) open.push([start, ids.length - 1]);
      for (const [a, b] of open) {
        const stops = [];
        for (let i = a; i <= b; i++) if (!closedSet.has(i)) stops.push(ids[i]);
        if (stops.length >= 2) pats.push(L._mk(`X${pats.length}`, stops));
      }
    } else {
      // solo estaciones sueltas cerradas: los trenes las cruzan sin detenerse
      const stops = ids.filter((_, i) => !closedSet.has(i));
      if (stops.length >= 2) pats.push(L._mk('X0', stops));
    }
    ep.pats = pats;
    return pats;
  }

  _inWindow(L, day, t) {
    return L.expWin[day].some(([a, b]) => t >= a && t < b);
  }

  /** ¿Está vigente la operación expresa de la línea en este instante? */
  expressActive(lineId, sec, day) {
    const L = this.byId.get(lineId);
    return Boolean(L?.pat.R) && this._inWindow(L, day, sec);
  }

  _departures(L, day) {
    const cacheKey = `${day}|v${this.ovVersion}`;
    if (!L.departures[cacheKey]) {
      let entries = []; // [t, patId | patternObj]
      const vfreq = L.def.express?.freq;
      if (L.pat.R && vfreq) {
        // El feed trae headways por variante: cada una con sus franjas. Roja y
        // Verde se despachan ALTERNADAS, así que la Verde va desfasada medio
        // headway; sin el desfase ambas arrancan en el borde de la franja y
        // salen en el mismo segundo, superponiendo dos trenes en el terminal.
        // (La agregación en franjas pierde la fase real de cada salida; el
        // desfase la reconstruye, que es como opera la Ruta Expresa.)
        for (const k of ['R', 'V']) {
          for (const [a, b, h] of vfreq[k]?.[day] || []) {
            const from = hhmmToSec(a) + (k === 'V' ? Math.floor(h / 2) : 0);
            for (let t = from; t < hhmmToSec(b); t += h) entries.push([t, k]);
          }
        }
        for (const [a, b, h] of L.def.freq[day] || []) {
          for (let t = hhmmToSec(a); t < hhmmToSec(b); t += h) {
            if (!this._inWindow(L, day, t)) entries.push([t, 'C']);
          }
        }
        entries.sort((x, y) => x[0] - y[0]);
      } else {
        // franjas de la línea; en ventana expresa se alterna Roja/Verde
        let toggle = 0;
        let last = -Infinity;
        for (const [a, b, headway] of L.def.freq[day] || []) {
          const start = hhmmToSec(a), end = hhmmToSec(b);
          const from = Math.max(start, last + headway);
          for (let t = from; t < end; t += headway) {
            const exp = L.pat.R && this._inWindow(L, day, t);
            entries.push([t, exp ? (toggle++ % 2 === 0 ? 'R' : 'V') : 'C']);
            last = t;
          }
        }
      }
      // contingencias: transformar las salidas afectadas por episodios
      if (L.episodes.length) {
        const out = [];
        for (const [t, pat] of entries) {
          const ep = L.episodes.find((e) =>
            e.mode !== 'notice' && t >= e.from && (e.to == null || t < e.to));
          if (!ep) { out.push([t, pat]); continue; }
          if (ep.mode === 'suspended') continue; // sin salidas durante la suspensión
          for (const P of this._epPatterns(L, ep)) out.push([t, P]);
        }
        entries = out;
      }
      L.departures[cacheKey] = {
        times: entries.map((e) => e[0]),
        pats: entries.map((e) => e[1]),
      };
    }
    return L.departures[cacheKey];
  }

  _resolvePat(L, p) {
    return typeof p === 'string' ? (L.pat[p] || L.pat.C) : p;
  }

  /**
   * Recalcula la flota activa para el instante dado.
   * Los objetos tren se reutilizan de un pool (cero allocations por frame).
   */
  update(sec, day) {
    this._pool ??= [];
    let n = 0;
    this.byKey.clear();
    for (const L of this.lines) {
      const { times, pats } = this._departures(L, day);
      if (!times.length) continue;
      let lo = lowerBound(times, sec - L.maxTrip - 1);
      for (let k = lo; k < times.length && times[k] <= sec; k++) {
        const P = this._resolvePat(L, pats[k]);
        const t0 = times[k];
        // ¿un episodio pilló a este tren en viaje? (partió antes del cambio)
        let ep = null;
        for (const e2 of L.episodes) {
          if (e2.mode === 'notice') continue;
          if (e2.from > t0 && e2.from < t0 + P.trip && sec >= e2.from) { ep = e2; break; }
        }
        for (let dir = 0; dir < 2; dir++) {
          let e = sec - t0;
          let frozen = false;
          if (ep) {
            // frena en la próxima parada tras el inicio del episodio y queda
            // atenuado; si el servicio se restablece, se retira con calma
            const { arr } = P.sched[dir];
            const rel = ep.from - t0;
            let j = upperBound(arr, rel);
            const fz = j < arr.length ? arr[j] : P.trip;
            if (e >= fz) {
              if (ep.to != null && sec > ep.to + 30) continue; // retirado
              e = fz;
              frozen = true;
            }
          }
          const tr = this._locate(L, P, dir, e, (this._pool[n] ??= {}));
          if (tr) {
            tr.key = `${L.def.id}|${dir}|${k}`;
            tr.frozen = frozen;
            this.trains[n++] = tr;
            this.byKey.set(tr.key, tr);
          }
        }
      }
    }
    this.trains.length = n;
    return this.trains;
  }

  _locate(L, P, dir, e, out = {}) {
    if (e < 0 || e > P.trip) return null;
    const { arr, dep } = P.sched[dir];
    const m = P.stops.length;
    const S = L.def.stationS, Q = L.def.schemStationS;
    const stopAt = (l) => P.stops[dir === 0 ? l : m - 1 - l];
    const name = (g) => L.def.stations[g];

    // j: última parada (en orden del sentido) a la que ya se llegó
    const j = Math.max(0, upperBound(arr, e) - 1);
    let sGeo, sSchem, moving = false, vKmh = 0;
    let next = null, etaNext = 0, dwell = null, dwellRemain = 0, gA, gB;
    if (j >= m - 1) {
      const g = stopAt(m - 1);
      sGeo = S[g]; sSchem = Q[g]; gA = gB = g;
      dwell = name(g); // llegó al terminal
    } else if (e >= dep[j]) {
      moving = true; // en ruta entre paradas j → j+1 del patrón
      gA = stopAt(j); gB = stopAt(j + 1);
      const k = dir === 0 ? j : m - 2 - j; // índice de tramo ascendente
      const D = Math.abs(S[gB] - S[gA]);
      const T = arr[j + 1] - dep[j];
      const tau = e - dep[j];
      const f = profileDist(P.prof[k], tau, T, D) / D;
      vKmh = profileVel(P.prof[k], tau, T) * 3.6;
      sGeo = S[gA] + (S[gB] - S[gA]) * f;
      sSchem = Q[gA] + (Q[gB] - Q[gA]) * f;
      next = name(gB);
      etaNext = arr[j + 1] - e;
    } else {
      const g = stopAt(j);
      sGeo = S[g]; sSchem = Q[g]; gA = gB = g;
      dwell = name(g);
      dwellRemain = dep[j] - e;
      next = name(stopAt(j + 1));
      etaNext = arr[j + 1] - e;
    }

    out.lineId = L.def.id;
    out.dir = dir;
    out.moving = moving;
    out.pattern = P.id;
    out.sGeo = sGeo; out.sSchem = sSchem;
    out.gA = gA; out.gB = gB;
    out.next = next; out.etaNext = etaNext;
    out.dwell = dwell; out.dwellRemain = dwellRemain;
    out.vKmh = vKmh;
    out.dest = name(stopAt(m - 1));
    return out;
  }

  /** Estaciones que este tren cruzará SIN detenerse antes de su próxima parada. */
  skipsBefore(t) {
    if (!t || !t.moving || t.pattern === 'C') return [];
    const L = this.byId.get(t.lineId);
    const P = L.pat[t.pattern];
    const out = [];
    const step = t.gB > t.gA ? 1 : -1;
    for (let g = t.gA + step; g !== t.gB; g += step) {
      if (!P.stopSet.has(g)) out.push(L.def.stations[g]);
    }
    return out;
  }

  /**
   * Próximas llegadas simuladas a una estación, dentro de un horizonte de
   * 30 min (como un letrero de andén real). Solo anuncia trenes que
   * efectivamente paran ahí; agrega filas {passing:true} cuando un expreso
   * la cruzará sin detenerse. Ordenadas por eta.
   */
  arrivals(stationId, sec, day, perDir = 2, horizon = 1800) {
    const out = [];
    for (const L of this.lines) {
      const gidx = L.def.stations.indexOf(stationId);
      if (gidx < 0) continue;
      const { times, pats } = this._departures(L, day);
      // patrones estáticos + los de contingencia del episodio vigente
      const activePats = [...Object.values(L.pat), ...(L.ov?.pats || [])];
      for (const P of activePats) {
        const m = P.stops.length;
        const li = P.stops.indexOf(gidx);
        for (let dir = 0; dir < 2; dir++) {
          const { arr, dep } = P.sched[dir];
          if (li >= 0) {
            const local = dir === 0 ? li : m - 1 - li;
            if (local === m - 1) continue; // terminal de destino de este sentido
            const destId = L.def.stations[dir === 0 ? P.stops[m - 1] : P.stops[0]];
            const off = arr[local];
            let count = 0;
            for (let k = lowerBound(times, sec - P.trip - 1); k < times.length && count < perDir; k++) {
              if (this._resolvePat(L, pats[k]) !== P) continue;
              const arrT = times[k] + off;
              if (local > 0 && arrT <= sec && sec < times[k] + dep[local]) {
                out.push({ lineId: L.def.id, pattern: P.id, dest: destId, eta: 0, atPlatform: true });
                count++;
              } else if (local === 0 && times[k] >= sec && times[k] - sec <= DWELL) {
                out.push({ lineId: L.def.id, pattern: P.id, dest: destId, eta: 0, atPlatform: true });
                count++;
              } else if (arrT > sec) {
                if (arrT - sec > horizon) break; // times es ascendente
                out.push({ lineId: L.def.id, pattern: P.id, dest: destId, eta: arrT - sec, atPlatform: false });
                count++;
              }
            }
          } else if (P.id !== 'C') {
            // el expreso pasa sin detenerse: estimar el próximo cruce
            let seg = -1;
            for (let k = 0; k < m - 1; k++) {
              if (P.stops[k] < gidx && gidx < P.stops[k + 1]) { seg = k; break; }
            }
            if (seg < 0) continue;
            const S = L.def.stationS;
            const localSeg = dir === 0 ? seg : m - 2 - seg;
            const T = arr[localSeg + 1] - dep[localSeg];
            const D = S[P.stops[seg + 1]] - S[P.stops[seg]];
            const distIn = dir === 0 ? S[gidx] - S[P.stops[seg]] : S[P.stops[seg + 1]] - S[gidx];
            const off = dep[localSeg] + T * (distIn / D); // aprox. lineal dentro del tramo
            for (let k = lowerBound(times, sec - off); k < times.length; k++) {
              if (this._resolvePat(L, pats[k]) !== P) continue;
              const passT = times[k] + off;
              if (passT <= sec) continue;
              if (passT - sec > horizon) break;
              out.push({ lineId: L.def.id, pattern: P.id, eta: passT - sec, passing: true });
              break;
            }
          }
        }
      }
    }
    return out.sort((a, b) => a.eta - b.eta);
  }

  /** true si la línea tiene servicio (o trenes rezagados) en este instante. */
  serviceOpen(sec, day) {
    return this.lines.some((L) => {
      const [a, b] = L.def.service[day] || ['06:00', '23:00'];
      return sec >= hhmmToSec(a) && sec <= hhmmToSec(b) + L.maxTrip;
    });
  }

  nextOpening(sec, day) {
    const openAt = (d) => Math.min(...this.lines.map((L) => hhmmToSec(L.def.service[d][0])));
    const today = openAt(day);
    if (sec < today) return { when: 'hoy', at: today };
    const next = day === 'sa' ? 'su' : 'wd'; // aproximación suficiente para el aviso
    return { when: 'mañana', at: openAt(next) };
  }
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}
function upperBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; }
  return lo;
}
