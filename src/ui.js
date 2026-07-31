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
    if (this.led.hidden) {
      this.led.hidden = false;
      gsap.fromTo(this.led, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power3.out' });
    }
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
    gsap.to(this.cabHud, { opacity: 0, duration: 0.4, onComplete: () => { this.cabHud.hidden = true; } });
    gsap.to(this.cabVignette, { opacity: 0, duration: 0.8, onComplete: () => { this.cabVignette.hidden = true; } });
    document.getElementById('hud').style.display = '';
  }

  setClosed(closed, opening) {
    if (closed === !this.closedEl.hidden) return;
    if (closed) {
      this.closedMsg.textContent = opening
        ? `El servicio comienza ${opening.when} a las ${secToHHMM(opening.at)}`
        : 'Fuera del horario de servicio';
      this.closedEl.hidden = false;
      gsap.fromTo(this.closedEl, { opacity: 0 }, { opacity: 1, duration: 0.6 });
    } else {
      gsap.to(this.closedEl, { opacity: 0, duration: 0.6, onComplete: () => { this.closedEl.hidden = true; } });
    }
  }
}
