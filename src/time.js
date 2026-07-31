// Reloj anclado a America/Santiago. La posición de cada tren es función de la
// hora local, así que todo el motor consume este reloj.
//
// Depuración: ?t=HH:MM fija la hora de partida (sigue corriendo desde ahí)
// y ?day=wd|sa|su fuerza el tipo de día.

const TZ = 'America/Santiago';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour12: false,
  weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/**
 * Hora de pared y tipo de día en America/Santiago para un instante dado.
 * Siempre vía Intl (Chile alterna UTC-3 en verano / UTC-4 en invierno);
 * jamás offsets fijos. Exportada para poder testearla con fechas conocidas.
 */
export function santiagoNow(date = new Date()) {
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const sec = (+parts.hour % 24) * 3600 + +parts.minute * 60 + +parts.second;
  const day = parts.weekday === 'Sat' ? 'sa' : parts.weekday === 'Sun' ? 'su' : 'wd';
  return { sec, day };
}

export class SantiagoClock {
  constructor() {
    const q = new URLSearchParams(location.search);
    const real = santiagoNow();
    this.day = q.get('day') || real.day;
    this.speed = 1; // multiplicador de tiempo (x1 / x10 / x60)
    const t = q.get('t');
    let startSec = real.sec;
    if (t && /^\d{1,2}:\d{2}$/.test(t)) {
      const [h, m] = t.split(':').map(Number);
      startSec = h * 3600 + m * 60;
    }
    this._anchorSec = startSec;
    this._anchorPerf = performance.now();
    this._overridden = Boolean(t);
    // re-anclar cada minuto contra el reloj real (deriva de performance.now),
    // solo mientras el reloj siga "en vivo"
    setInterval(() => {
      if (this._overridden || this.speed !== 1) return;
      const now = santiagoNow();
      this._anchorSec = now.sec;
      this._anchorPerf = performance.now();
      this.day = q.get('day') || now.day;
    }, 60_000);
  }

  /** Segundos del día (float), hora local de Santiago (o simulada en demo). */
  sec() {
    const s = this._anchorSec + ((performance.now() - this._anchorPerf) / 1000) * this.speed;
    return ((s % 86400) + 86400) % 86400;
  }

  /** Cambia el multiplicador sin saltos (re-ancla en la hora actual). */
  setSpeed(k) {
    this._anchorSec = this.sec();
    this._anchorPerf = performance.now();
    this.speed = k;
    if (k !== 1) this._overridden = true;
  }

  /** Modo demo: fija la hora del día (sigue corriendo desde ahí). */
  setTime(sec) {
    this._anchorSec = sec;
    this._anchorPerf = performance.now();
    this._overridden = true;
  }

  /** Vuelve al tiempo real de Santiago a x1. */
  goLive() {
    const now = santiagoNow();
    this._anchorSec = now.sec;
    this._anchorPerf = performance.now();
    this.day = now.day;
    this.speed = 1;
    this._overridden = false;
  }

  get isLive() { return !this._overridden && this.speed === 1; }

  hms() {
    const s = Math.floor(this.sec());
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  }
}

export const hhmmToSec = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 3600 + m * 60;
};

export const secToHHMM = (s) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600) % 24)}:${p(Math.floor((s % 3600) / 60))}`;
};
