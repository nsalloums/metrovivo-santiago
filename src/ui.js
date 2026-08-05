// Capa de UI: señalética metropolitana en DOM. Insignias-filtro, reloj,
// contador, selector y placa de andén (tooltip), panel LED de llegadas y
// overlay "Metro cerrado". Microanimaciones con GSAP.

import { gsap } from 'gsap';
import { secToHHMM } from './time.js';

export class UI {
  constructor(data, { onToggleLine, onSelectStation, onToggleMode, onSpeed, onTime, onLive, onCabExit }) {
    this.data = data;
    this.selected = null;

    // ── control de tiempo: x1/x10/x60 + slider de hora (modo demo) ──
    this.tcButtons = [...document.querySelectorAll('#time-controls .tc')];
    this.tcButtons.forEach((b) => {
      b.addEventListener('click', () => {
        this.setSpeedActive(+b.dataset.speed);
        onSpeed(+b.dataset.speed);
      });
    });
    this.liveBtn = document.getElementById('live-btn');
    this.liveBtn.addEventListener('click', () => { this.setSpeedActive(1); onLive(); });
    this.slider = document.getElementById('hour-slider');
    this._sliderHeld = false;
    this.slider.addEventListener('pointerdown', () => { this._sliderHeld = true; });
    addEventListener('pointerup', () => { this._sliderHeld = false; });
    this.slider.addEventListener('input', () => onTime(+this.slider.value));

    // ── overlay de debug (tecla D) ──
    this.debugEl = document.getElementById('debug');

    // ── HUD de cabina ──
    this.cabHud = document.getElementById('cab-hud');
    this.cabVignette = document.getElementById('cab-vignette');
    this.cabBadge = this.cabHud.querySelector('.cab-badge');
    this.cabNext = this.cabHud.querySelector('.cab-next');
    this.cabMeta = this.cabHud.querySelector('.cab-meta');
    this.cabSpeedEl = this.cabHud.querySelector('.cab-speed b');
    this._lastSpeed = -1;
    document.getElementById('cab-exit').addEventListener('click', () => onCabExit());

    // ── insignias de línea (filtro) ──
    const badges = document.getElementById('badges');
    this.badgeEls = new Map();
    for (const line of data.lines) {
      const b = document.createElement('button');
      b.className = 'badge';
      b.style.setProperty('--c', line.color);
      b.textContent = line.id.slice(1);
      b.title = line.name;
      b.setAttribute('aria-label', `Mostrar u ocultar ${line.name}`);
      b.setAttribute('aria-pressed', 'true');
      b.addEventListener('click', () => {
        const on = b.classList.toggle('off') === false;
        b.setAttribute('aria-pressed', String(on));
        gsap.fromTo(b, { scale: 0.8 }, { scale: 1, duration: 0.35, ease: 'back.out(3)' });
        onToggleLine(line.id, on);
      });
      badges.appendChild(b);
      this.badgeEls.set(line.id, b);
    }

    // ── toggle 2D/3D ──
    const toggle = document.getElementById('mode-toggle');
    this.knob = document.createElement('span');
    this.knob.className = 'knob';
    toggle.prepend(this.knob);
    this.opts = [...toggle.querySelectorAll('.opt')];
    requestAnimationFrame(() => this._placeKnob('3d', false));
    toggle.addEventListener('click', () => onToggleMode());

    // ── selector de estación ──
    const sel = document.getElementById('station-select');
    const sorted = Object.entries(data.stations).sort((a, b) => a[1].name.localeCompare(b[1].name, 'es'));
    for (const [id, st] of sorted) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = st.name;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onSelectStation(sel.value || null));
    this.sel = sel;

    // ── panel LED ──
    this.led = document.getElementById('led-panel');
    this.ledStation = this.led.querySelector('.led-station');
    this.ledRows = this.led.querySelector('.led-rows');
    this.ledInterior = this.led.querySelector('.led-interior');
    document.getElementById('led-close').addEventListener('click', () => onSelectStation(null));

    // ── tooltip / placa ──
    this.tip = document.getElementById('tooltip');
    this.tipName = this.tip.querySelector('.tt-name');
    this.tipBadges = this.tip.querySelector('.tt-badges');

    this.clockEl = document.getElementById('clock');
    this.countEl = document.getElementById('train-count');
    this.closedEl = document.getElementById('closed-overlay');
    this.closedMsg = document.getElementById('closed-msg');
    // el chip solo aparece si hay un escenario de contingencia inyectado
    this.estadoChip = document.getElementById('estado-chip');
    this.estadoTxt = this.estadoChip.querySelector('.txt');
    this.estadoChip.hidden = true;
    this.contingencia = document.getElementById('contingencia');
  }

  // ── escenario de contingencia (simulado) ──
  /**
   * Muestra el chip del escenario activo. Se rotula explícitamente como
   * simulado: metrovivo no consume estado real de la red (ver
   * src/scenarios.js), y un dato falso sería peor que ninguno.
   */
  setScenarioChip(name) {
    this.estadoChip.className = 'estado-alerts';
    this.estadoChip.title = `Escenario de contingencia simulado (?estado=${name})`;
    this.estadoTxt.textContent = `escenario simulado · ${name}`;
    this.estadoChip.hidden = false;
  }

  /** Banner con los mensajes del escenario (solo textContent, nunca innerHTML). */
  setContingencia(alerts) {
    if (!alerts.length) { this.contingencia.hidden = true; return; }
    this.contingencia.replaceChildren(...alerts.map(({ lineId, message }) => {
      const row = document.createElement('div');
      row.className = 'cline';
      const b = document.createElement('b');
      b.textContent = lineId;
      const span = document.createElement('span');
      span.textContent = message || 'Servicio con alteraciones';
      row.append(b, span);
      return row;
    }));
    this.contingencia.hidden = false;
  }

  /**
   * Chip del bus elegido en el mapa de flota. Todo lo que muestra es MEDIDO
   * (patente, servicio, velocidad reportada, hora de medición); la edad va
   * siempre visible porque es parte del dato. Solo textContent: los strings
   * vienen de un tercero.
   */
  setBusInfo(info) {
    const el = document.getElementById('bus-info');
    if (!el) return;
    if (!info) { el.hidden = true; return; }
    el.replaceChildren();
    const linea = document.createElement('b');
    linea.textContent = info.service ? `Servicio ${info.service}` : `Recorrido ${info.routeCode || '—'}`;
    el.append(linea);
    if (info.sim) {
      // bus simulado: no hay patente porque no hay vehículo — es el horario
      if (info.nombre) {
        const nom = document.createElement('span');
        nom.className = 'bi-nombre';
        nom.textContent = info.nombre;
        el.append(nom);
      }
      const meta = document.createElement('span');
      meta.textContent = `${info.dir === 'R' ? 'regreso' : 'ida'} · simulado según itinerario oficial`;
      el.append(meta);
      el.dataset.estrato = 'sim';
    } else {
      const patente = document.createElement('span');
      patente.className = 'bi-plate';
      patente.textContent = info.plate;
      const meta = document.createElement('span');
      const partes = [info.dir === 'R' ? 'regreso' : 'ida'];
      if (Number.isFinite(info.speed)) partes.push(`${Math.round(info.speed)} km/h reportados`);
      partes.push(`medido hace ${info.edadS < 60 ? Math.round(info.edadS) + ' s' : Math.round(info.edadS / 60) + ' min'}`);
      meta.textContent = partes.join(' · ');
      // por qué este bus no se puede conducir y el del itinerario sí
      const nota = document.createElement('span');
      nota.className = 'bi-nota';
      nota.textContent = 'Posición medida: no se viaja dentro. Cambia a ITINERARIO para subirte.';
      el.append(patente, meta, nota);
      el.dataset.estrato = 'avl';
    }
    el.hidden = false;
  }

  /** Aviso puntual de la capa de buses (encadenado, rastro perdido, carga). */
  setBusAviso(texto) {
    if (!this._busAviso) {
      this._busAviso = document.createElement('div');
      this._busAviso.id = 'bus-aviso';
      this._busAviso.hidden = true;
      document.body.append(this._busAviso);
    }
    if (!texto) { this._busAviso.hidden = true; return; }
    this._busAviso.textContent = texto; // nunca innerHTML: puede citar datos de un tercero
    this._busAviso.hidden = false;
    clearTimeout(this._busAvisoT);
    this._busAvisoT = setTimeout(() => { this._busAviso.hidden = true; }, 6000);
  }

  _placeKnob(mode, animate = true) {
    const opt = this.opts.find((o) => o.dataset.mode === mode);
    if (!opt) return;
    this.opts.forEach((o) => o.classList.toggle('active', o === opt));
    const x = opt.offsetLeft, w = opt.offsetWidth;
    if (animate) gsap.to(this.knob, { left: x, width: w, duration: 0.45, ease: 'power2.inOut' });
    else gsap.set(this.knob, { left: x, width: w });
  }

  setMode(mode) { this._placeKnob(mode); }

  setClock(hms) { this.clockEl.textContent = hms; }

  setTrainCount(n) {
    this.countEl.textContent = n === 1 ? '1 tren' : `${n} trenes`;
  }

  /** El contador de trenes se oculta en modo buses: contaría vehículos invisibles. */
  setTrainCountVisible(on) { this.countEl.hidden = !on; }

  miniBadge(lineId) {
    const line = this.data.lines.find((l) => l.id === lineId);
    const s = document.createElement('span');
    s.className = 'badge mini';
    s.style.setProperty('--c', line.color);
    s.textContent = lineId.slice(1);
    return s;
  }

  // ── tooltip placa de andén ──
  /**
   * expressCls: [{lineId, cls}] con la clasificación R/V/C vigente (solo en
   * horario expreso). closed: placa gris "estación cerrada" (por escenario).
   */
  showTooltip(stationId, x, y, expressCls = [], closed = false) {
    const st = this.data.stations[stationId];
    const cacheKey = stationId + '|' + expressCls.map((e) => e.lineId + e.cls).join(',') + (closed ? '|X' : '');
    if (this._tipFor !== cacheKey) {
      this.tipName.textContent = st.name;
      const chips = expressCls.map(({ cls }) => {
        const s = document.createElement('span');
        s.className = `xchip xchip-${cls}`;
        s.textContent = cls;
        s.title = cls === 'R' ? 'Ruta Roja' : cls === 'V' ? 'Ruta Verde' : 'Estación común';
        return s;
      });
      if (closed) {
        const s = document.createElement('span');
        s.className = 'xchip xchip-cerrada';
        s.textContent = 'CERRADA';
        chips.push(s);
      }
      this.tipBadges.replaceChildren(...st.lines.map((l) => this.miniBadge(l)), ...chips);
      const main = this.data.lines.find((l) => l.id === st.lines[0]);
      this.tip.style.borderLeftColor = closed ? '#5a5a64' : main.color;
      this.tip.classList.toggle('closed', closed);
      this._tipFor = cacheKey;
    }
    if (this.tip.hidden) {
      this.tip.hidden = false;
      gsap.fromTo(this.tip, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.2, ease: 'power2.out' });
    }
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
  }

  hideTooltip() {
    if (!this.tip.hidden) { this.tip.hidden = true; this._tipFor = null; }
  }

  // ── panel LED ──
  selectStation(stationId) {
    this.selected = stationId;
    this.sel.value = stationId || '';
    if (!stationId) {
      if (!this.led.hidden) {
        gsap.to(this.led, {
          opacity: 0, y: 14, duration: 0.25, ease: 'power2.in',
          onComplete: () => { this.led.hidden = true; gsap.set(this.led, { clearProps: 'all' }); },
        });
      }
      return;
    }
    this.ledStation.textContent = this.data.stations[stationId].name.toUpperCase();
    this.ledRows.innerHTML = '<div class="led-empty">CARGANDO…</div>';
    this._renderInterior(this.data.stations[stationId]);
    if (this.led.hidden) {
      this.led.hidden = false;
      gsap.fromTo(this.led, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power3.out' });
    }
  }

  /**
   * Interior de la estación, de pathways.txt y levels.txt del GTFS oficial.
   * A diferencia de las llegadas —que son simulación— esto es dato medido:
   * el tiempo de combinación es la suma de los traversal_time del camino más
   * corto entre los andenes de una línea y los de la otra. Por eso va en su
   * propio bloque y no mezclado con el letrero de próximos trenes.
   */
  _renderInterior(st) {
    const el = this.ledInterior;
    if (!el) return;
    const inf = st?.in;
    if (!inf) { el.hidden = true; el.replaceChildren(); return; }
    const mmss = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    const filas = [];

    for (const [par, c] of Object.entries(inf.comb || {})) {
      const [a, b] = par.split('|');
      const partes = [];
      if (c.esc) partes.push(`${c.esc} escalera${c.esc > 1 ? 's' : ''}`);
      if (c.mec) partes.push(`${c.mec} mecánica${c.mec > 1 ? 's' : ''}`);
      if (c.asc) partes.push(`${c.asc} ascensor${c.asc > 1 ? 'es' : ''}`);
      // el camino sin escalones solo se nombra si es DISTINTO del más corto
      if (c.sf != null && c.sf !== c.s) partes.push(`sin escalones ${mmss(c.sf)}`);
      else if (c.sf == null) partes.push('sin ruta accesible');
      filas.push({ k: `Combinación ${a}↔${b}`, v: mmss(c.s), extra: partes.join(' · ') });
    }

    // Metro de Santiago no es todo subterráneo: 19 andenes van en viaducto y
    // 5 a nivel de calle. Un "nivel 2" a secas se leería como profundidad.
    const nivel = (n) => (n < 0 ? `nivel ${n}` : n === 0 ? 'a nivel de calle' : `elevado, nivel +${n}`);
    const prof = Object.entries(inf.prof || {});
    if (prof.length) {
      filas.push({
        k: prof.length > 1 ? 'Andenes' : 'Andén',
        v: prof.map(([l, n]) => `${l} ${nivel(n)}`).join(' · '),
        extra: inf.niveles > 1 ? `${inf.niveles} niveles en total` : '',
      });
    }
    if (inf.accesos) {
      filas.push({
        k: 'Accesos',
        v: String(inf.accesos),
        extra: `${inf.accesosSF} sin escalones`,
      });
    }

    el.replaceChildren();
    const t = document.createElement('div');
    t.className = 'li-title';
    t.textContent = 'LA ESTACIÓN POR DENTRO · DATO OFICIAL';
    el.append(t);
    for (const f of filas) {
      const row = document.createElement('div');
      row.className = 'li-row';
      const k = document.createElement('span'); k.className = 'li-k'; k.textContent = f.k;
      const v = document.createElement('span'); v.className = 'li-v'; v.textContent = f.v;
      row.append(k, v);
      if (f.extra) {
        const e = document.createElement('span'); e.className = 'li-e'; e.textContent = f.extra;
        row.append(e);
      }
      el.append(row);
    }
    el.hidden = !filas.length;
  }

  updateArrivals(arrivals, alertMsg = null) {
    if (!this.selected) return;
    // aviso de contingencia como en los letreros reales (texto sanitizado)
    let alertRow = '';
    if (alertMsg) {
      const div = document.createElement('div');
      div.className = 'led-alert';
      div.textContent = alertMsg.toUpperCase();
      alertRow = div.outerHTML;
    }
    if (!arrivals.length) {
      this.ledRows.innerHTML = alertRow + '<div class="led-empty">SIN SERVICIO</div>';
      return;
    }
    const rows = arrivals.slice(0, 5).map((a, i) => {
      const s = Math.round(a.eta);
      const eta = a.atPlatform
        ? 'EN ANDÉN'
        : s < 60
          ? `${s} s`
          : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`;
      // solo R/V son rutas expresas; los patrones de contingencia (X…) no llevan chip
      const tag = a.pattern === 'R' || a.pattern === 'V'
        ? `<span class="l-pat l-pat-${a.pattern}">${a.pattern}</span>` : '';
      if (a.passing) {
        const label = tag ? 'EXPRESO PASA SIN DETENERSE' : 'PASA SIN DETENERSE';
        return `<div class="led-row pass">
          <span class="l-line">${a.lineId}${tag}</span>
          <span class="l-dest">${label}</span>
          <span class="l-eta">${eta}</span>
        </div>`;
      }
      const dest = this.data.stations[a.dest].name.toUpperCase();
      return `<div class="led-row${i > 1 ? ' dim' : ''}">
        <span class="l-line">${a.lineId}${tag}</span>
        <span class="l-dest">→ ${dest}</span>
        <span class="l-eta">${eta}</span>
      </div>`;
    });
    this.ledRows.innerHTML = alertRow + rows.join('');
  }

  /**
   * Panel de créditos: quién hizo esto, de dónde salen los datos y qué es
   * medido frente a qué es simulado. Va en la propia demo y no sólo en el
   * NOTICE.md del repositorio, porque quien entra al sitio nunca ve el repo.
   * @param calendar data.calendar — la versión del feed que se está mostrando
   */
  initCreditos(calendar) {
    const panel = document.getElementById('creditos');
    const btn = document.getElementById('info-btn');
    if (!panel || !btn) return;
    const feed = document.getElementById('cr-feed');
    if (feed && calendar?.version) {
      const f = (d) => (d ? `${d.slice(6, 8)}-${d.slice(4, 6)}-${d.slice(0, 4)}` : '?');
      feed.textContent = `feed ${calendar.version}, vigente hasta el ${f(calendar.end)}`;
    } else if (feed) {
      feed.textContent = 'dataset de ejemplo incluido en el repositorio';
    }
    const abrir = (on) => {
      panel.hidden = !on;
      btn.setAttribute('aria-expanded', String(on));
      if (on) gsap.fromTo(panel, { opacity: 0, y: -8 }, { opacity: 1, y: 0, duration: 0.25 });
    };
    btn.addEventListener('click', () => abrir(panel.hidden));
    document.getElementById('creditos-close')?.addEventListener('click', () => abrir(false));
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) abrir(false); });
  }

  /**
   * Avisos sobre los DATOS, no sobre la red: hoy es feriado (y por eso los
   * trenes van con horario de domingo un viernes), o el feed que alimenta
   * todos los horarios ya venció. Ambos son cosas que el visitante no puede
   * deducir mirando la pantalla, y que cambian cómo hay que leerla.
   */
  setDatosAviso({ feriado = null, vigencia = null } = {}) {
    const el = document.getElementById('datos-aviso');
    if (!el) return;
    const NOMBRE = { wd: 'día hábil', sa: 'sábado', su: 'domingo' };
    const fecha = (f) => (f ? `${f.slice(6, 8)}-${f.slice(4, 6)}-${f.slice(0, 4)}` : '');
    const partes = [];
    if (feriado) partes.push(`<b>Feriado</b> — la red opera con horario de ${NOMBRE[feriado] || feriado}`);
    if (vigencia) {
      partes.push(`<b>Horarios vencidos</b> — el feed ${vigencia.version || ''} valía hasta el ${fecha(vigencia.hasta)}`.trim());
    }
    if (!partes.length) { el.hidden = true; el.replaceChildren(); return; }
    el.replaceChildren();
    for (const p of partes) {
      const d = document.createElement('div');
      d.className = 'cline';
      d.innerHTML = p; // texto propio, no viene de la red
      el.append(d);
    }
    el.classList.toggle('vencido', Boolean(vigencia));
    el.hidden = false;
  }

  // ── control de tiempo ──
  setSpeedActive(k) {
    this.tcButtons.forEach((b) => b.classList.toggle('active', +b.dataset.speed === k));
  }

  setLive(live) {
    this.liveBtn.classList.toggle('off', !live);
    this.liveBtn.textContent = live ? '● VIVO' : '○ DEMO';
  }

  reflectTime(sec) {
    if (!this._sliderHeld) this.slider.value = Math.floor(sec / 60) * 60;
  }

  // ── debug (tecla D) ──
  toggleDebug() { this.debugEl.hidden = !this.debugEl.hidden; }
  get debugVisible() { return !this.debugEl.hidden; }
  setDebug(text) { this.debugEl.textContent = text; }

  // ── HUD de cabina ──
  cabShow(lineId) {
    const line = this.data.lines.find((l) => l.id === lineId);
    this.cabBadge.style.setProperty('--c', line.color);
    this.cabBadge.textContent = lineId.slice(1);
    this.cabNext.textContent = '';
    this.cabMeta.textContent = '';
    this.cabHud.hidden = false;
    this.cabVignette.hidden = false;
    document.getElementById('hud').style.display = 'none';
    gsap.fromTo(this.cabHud, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.5, delay: 0.7 });
    gsap.fromTo(this.cabVignette, { opacity: 0 }, { opacity: 1, duration: 1.2, delay: 0.4 });
  }

  /** Igual que cabShow, pero la insignia es un servicio de bus, no una línea. */
  cabShowBus(info) {
    this.cabBadge.style.setProperty('--c', '#ffb000'); // ámbar: estrato simulado
    this.cabBadge.textContent = info.service;
    this.cabBadge.classList.add('bus');
    this.cabNext.textContent = '';
    this.cabMeta.textContent = info.nombre || '';
    this.cabHud.hidden = false;
    this.cabVignette.hidden = false;
    document.getElementById('hud').style.display = 'none';
    gsap.fromTo(this.cabHud, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.5, delay: 0.7 });
    gsap.fromTo(this.cabVignette, { opacity: 0 }, { opacity: 1, duration: 1.2, delay: 0.4 });
  }

  cabUpdateBus(info) {
    if (!info) return;
    const mmss = (s) => {
      s = Math.max(0, Math.round(s));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    this.cabNext.innerHTML = info.next
      ? `Próximo paradero: ${info.next} <span class="eta">${mmss(info.etaNext)}</span>`
      : 'Terminal';
    const partes = [];
    // el letrero del bus: destino oficial del viaje, no la esquina final
    if (info.dest) partes.push(info.circular ? `circular · ${info.dest}` : `a ${info.dest}`);
    if (info.restantes != null) partes.push(`quedan ${info.restantes} paraderos`);
    // el origen del dato viaja con el dato, también acá dentro
    partes.push('según itinerario oficial');
    this.cabMeta.textContent = partes.join(' · ');
  }

  cabUpdate(info) {
    const mmss = (s) => {
      s = Math.max(0, Math.round(s));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const route = info.pattern === 'R'
      ? '<span class="route-tag route-R">RUTA ROJA</span> '
      : info.pattern === 'V'
        ? '<span class="route-tag route-V">RUTA VERDE</span> '
        : '';
    const stopWord = route ? 'parada' : 'estación';
    if (info.dwell) {
      const name = this.data.stations[info.dwell].name;
      this.cabNext.innerHTML = `${route}Deteniéndose en ${name}`;
      this.cabMeta.textContent = info.next
        ? `sale en ${Math.max(0, Math.round(info.dwellRemain))} s · destino ${this.data.stations[info.dest].name}`
        : `terminal · fin del recorrido`;
    } else if (info.next) {
      this.cabNext.innerHTML =
        `${route}Próxima ${stopWord}: ${this.data.stations[info.next].name} <span class="eta">${mmss(info.etaNext)}</span>`;
      const skips = (info.skips || []).map((id) => this.data.stations[id].name);
      this.cabMeta.textContent = skips.length
        ? `no se detiene en: ${skips.slice(0, 3).join(' · ')}${skips.length > 3 ? ' …' : ''}`
        : `destino ${this.data.stations[info.dest].name} · ${info.hms}`;
    }
  }

  /** Contingencia en cabina: aviso antes de la salida elegante a la órbita. */
  cabServiceAlert() {
    this.cabNext.innerHTML = '<span class="route-tag" style="background:#5a5a64">SERVICIO SUSPENDIDO</span> Volviendo a la vista de red…';
    this.cabMeta.textContent = 'la contingencia de la línea interrumpió este viaje';
  }

  /** Velocímetro real: se alimenta por frame desde el perfil de velocidad. */
  cabSpeed(vKmh) {
    const v = Math.round(vKmh);
    if (v !== this._lastSpeed) {
      this._lastSpeed = v;
      this.cabSpeedEl.textContent = v;
    }
  }

  cabHide() {
    this.cabBadge.classList.remove('bus');
    gsap.to(this.cabHud, { opacity: 0, duration: 0.4, onComplete: () => { this.cabHud.hidden = true; } });
    gsap.to(this.cabVignette, { opacity: 0, duration: 0.8, onComplete: () => { this.cabVignette.hidden = true; } });
    document.getElementById('hud').style.display = '';
  }

  // El overlay de cierre es un hecho del METRO, no de la ciudad: quien llama
  // (main.js) solo lo enciende en modo metro. En modo buses no existe — los
  // servicios nocturnos de RED circulan igual y taparlos sería esconder dato
  // real detrás del calendario del metro.
  setClosed(closed, opening) {
    // El guard compara contra el estado DESEADO, no contra `hidden`: hidden
    // solo cambia cuando el fundido termina, y un cambio de modo más rápido
    // que el fundido (0,6 s) dejaría el overlay visible pero no-interactivo.
    if (closed === (this._closedShown ?? false)) return;
    this._closedShown = closed;
    gsap.killTweensOf(this.closedEl); // un cambio rápido de modo no deja tweens cruzados
    if (closed) {
      this.closedMsg.textContent = opening
        ? `El servicio comienza ${opening.when} a las ${secToHHMM(opening.at)}`
        : 'Fuera del horario de servicio';
      this.closedEl.hidden = false;
      this.closedEl.style.pointerEvents = '';
      gsap.fromTo(this.closedEl, { opacity: 0 }, { opacity: 1, duration: 0.6 });
    } else {
      // no-interactivo DESDE YA: el fundido dura 0,6 s y en ese lapso el
      // overlay no puede seguir tragándose los clics del modo buses
      this.closedEl.style.pointerEvents = 'none';
      gsap.to(this.closedEl, { opacity: 0, duration: 0.6, onComplete: () => { this.closedEl.hidden = true; } });
    }
  }
}
