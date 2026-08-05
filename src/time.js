// Reloj anclado a America/Santiago. La posición de cada tren es función de la
// hora local, así que todo el motor consume este reloj.
//
// Depuración: ?t=HH:MM fija la hora de partida (sigue corriendo desde ahí)
// y ?day=wd|sa|su fuerza el tipo de día.

const TZ = 'America/Santiago';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour12: false,
  weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/**
 * Hora de pared y tipo de día en America/Santiago para un instante dado.
 * Siempre vía Intl (Chile alterna UTC-3 en verano / UTC-4 en invierno);
 * jamás offsets fijos. Exportada para poder testearla con fechas conocidas.
 *
 * El tipo de día NO sale solo del día de la semana. `holidays` es la tabla de
 * calendar_dates.txt (fecha AAAAMMDD → tipo): el 18 de septiembre cae viernes
 * y la red opera con horario de domingo. Sin ella, ocho días al año la
 * simulación dibuja frecuencias de día hábil sobre una ciudad en festivo.
 */
export function santiagoNow(date = new Date(), holidays = null) {
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const sec = (+parts.hour % 24) * 3600 + +parts.minute * 60 + +parts.second;
  const ymd = `${parts.year}${parts.month}${parts.day}`;
  const semanal = parts.weekday === 'Sat' ? 'sa' : parts.weekday === 'Sun' ? 'su' : 'wd';
  const feriado = holidays?.[ymd] || null;
  return { sec, day: feriado || semanal, date: ymd, feriado, semanal };
}

export class SantiagoClock {
  /** @param calendar data.calendar de network.json: { holidays, start, end, version } */
  constructor(calendar = null) {
    const q = new URLSearchParams(location.search);
    this.calendar = calendar;
    this._holidays = calendar?.holidays || null;
    const real = santiagoNow(new Date(), this._holidays);
    this.day = q.get('day') || real.day;
    this.date = real.date;
    this.feriado = real.feriado;   // tipo de día que impone el feriado, o null
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
      const now = santiagoNow(new Date(), this._holidays);
      this._anchorSec = now.sec;
      this._anchorPerf = performance.now();
      this.day = q.get('day') || now.day;
      this.date = now.date;
      this.feriado = now.feriado; // a medianoche de un 17 de septiembre, cambia
    }, 60_000);
  }

  /**
   * ¿Los horarios que se están dibujando siguen vigentes? feed_info.txt trae
   * la ventana de validez del feed; fuera de ella la simulación sigue
   * produciendo trenes perfectamente creíbles con datos caducados, y eso es
   * justo lo que este proyecto no se permite callar.
   * → null si está vigente o no se sabe; { desde, hasta, fecha } si no.
   */
  vigencia() {
    const c = this.calendar;
    if (!c?.start || !c?.end) return null;
    const hoy = this.date;
    if (hoy >= c.start && hoy <= c.end) return null;
    return { desde: c.start, hasta: c.end, fecha: hoy, version: c.version || null };
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
    const now = santiagoNow(new Date(), this._holidays);
    this._anchorSec = now.sec;
    this._anchorPerf = performance.now();
    this.day = now.day;
    this.date = now.date;
    this.feriado = now.feriado;
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
