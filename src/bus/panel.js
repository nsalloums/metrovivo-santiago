// Panel de paradero: lo único de metrovivo que muestra un dato REAL.
//
// Es deliberadamente frío (azul-gris, no ámbar) para que nadie lo confunda con
// el letrero LED del metro, que muestra una simulación. Dos estratos de dato
// distintos no pueden compartir estética: en una captura de pantalla sin
// leyenda tienen que distinguirse solos.
//
// Sólo textContent, nunca innerHTML: estos strings vienen de un tercero.

import { ESTADOS } from './provider.js';

const seg = (ms) => Math.max(0, Math.round(ms / 1000));

export class BusPanel {
  constructor(root, { onFollow, onClose } = {}) {
    this.root = root;
    this.onFollow = onFollow;
    this.onClose = onClose;
    this.seguido = null; // patente que el usuario eligió seguir
    this._lectura = null;

    root.innerHTML = ''; // el contenedor nace vacío y se construye con el DOM
    root.hidden = true;

    const head = el('div', 'bus-head');
    this.titulo = el('strong', 'bus-title');
    this.codigo = el('span', 'bus-code');
    const cerrar = el('button', 'bus-close');
    cerrar.type = 'button';
    cerrar.textContent = '✕';
    cerrar.setAttribute('aria-label', 'Cerrar panel de paradero');
    cerrar.addEventListener('click', () => this.onClose?.());
    head.append(this.titulo, this.codigo, cerrar);

    this.lista = el('ul', 'bus-list');
    this.estado = el('p', 'bus-state');
    this.pie = el('p', 'bus-foot');

    root.append(head, this.estado, this.lista, this.pie);
  }

  abrir(code, nombre) {
    this.root.hidden = false;
    this.seguido = null;
    this.titulo.textContent = nombre || 'Paradero';
    this.codigo.textContent = code;
    this.lista.replaceChildren();
    this.estado.textContent = 'Consultando a RED…';
    this.estado.dataset.tono = 'espera';
    this.pie.textContent = '';
  }

  cerrar() { this.root.hidden = true; this.seguido = null; this._lectura = null; }

  /** Pinta una lectura del provider. */
  render(lectura, ahora = Date.now()) {
    this._lectura = lectura;
    const l = lectura;
    this.lista.replaceChildren();

    if (l.state === ESTADOS.OK) {
      this.estado.textContent = `${l.buses.length} bus${l.buses.length === 1 ? '' : 'es'} en camino`;
      this.estado.dataset.tono = 'ok';
      // ordenados por cercanía: es como los lee cualquiera en el paradero
      const buses = [...l.buses].sort((a, b) => (a.meters ?? 1e9) - (b.meters ?? 1e9));
      for (const b of buses) this.lista.append(this._fila(b));
    } else {
      this.estado.textContent = l.message;
      this.estado.dataset.tono = l.state === ESTADOS.SIN_DATOS ? 'vacio' : 'error';
      // una lectura fallida no borra lo último que sí supimos, pero lo marca
      if (l.previa?.buses.length) {
        const edad = seg(ahora - l.previa.fetchedAtWall);
        const aviso = el('li', 'bus-stale');
        aviso.textContent = `Última lectura buena hace ${humano(edad)}:`;
        this.lista.append(aviso);
        for (const b of [...l.previa.buses].sort((a, b2) => (a.meters ?? 1e9) - (b2.meters ?? 1e9))) {
          this.lista.append(this._fila(b, true));
        }
      }
    }
    this.actualizarEdad(ahora);
  }

  _fila(bus, viejo = false) {
    const li = el('li', 'bus-row');
    if (viejo) li.classList.add('is-stale');
    const seguido = this.seguido === bus.plate;
    if (seguido) li.classList.add('is-followed');

    const svc = el('span', 'bus-svc');
    svc.textContent = bus.service;

    const dist = el('span', 'bus-dist');
    dist.textContent = bus.meters === 0 ? 'en el paradero'
      : bus.meters == null ? 'sin distancia'
      : bus.meters < 1000 ? `${bus.meters} m`
      : `${(bus.meters / 1000).toFixed(1)} km`;

    const eta = el('span', 'bus-eta');
    eta.textContent = etaTexto(bus);

    // La patente sólo aparece en el bus que el usuario elige seguir. Es
    // pública (va pintada en el exterior) y es lo que vuelve VERIFICABLE el
    // seguimiento —puedes mirar el bus y comprobar que no mentimos—, pero
    // patente + posición + hora sostenidas en el tiempo describen la jornada
    // de una persona identificable por quien conoce el turno. Nunca en listas,
    // nunca en localStorage, nunca en la URL.
    const btn = el('button', 'bus-follow');
    btn.type = 'button';
    btn.textContent = seguido ? bus.plate : 'seguir';
    btn.title = seguido ? 'Patente del bus que estás siguiendo' : 'Seguir este bus en el mapa';
    btn.disabled = viejo || bus.meters == null;
    btn.addEventListener('click', () => {
      this.seguido = this.seguido === bus.plate ? null : bus.plate;
      this.onFollow?.(this.seguido, bus);
      if (this._lectura) this.render(this._lectura);
    });

    li.append(svc, dist, eta, btn);
    return li;
  }

  /** Se llama a 1 Hz: la edad del dato es parte del dato. */
  actualizarEdad(ahora = Date.now()) {
    const l = this._lectura;
    if (!l) return;
    const base = l.state === ESTADOS.OK || l.state === ESTADOS.SIN_DATOS
      ? l.fetchedAtWall
      : l.previa?.fetchedAtWall;
    if (!base) { this.pie.textContent = 'Datos en vivo de RED vía api.xor.cl'; return; }
    this.pie.textContent = `Consultado hace ${humano(seg(ahora - base))} · datos en vivo de RED vía api.xor.cl`;
  }
}

function etaTexto(b) {
  if (b.minEta == null && b.maxEta == null) return '';
  if (b.minEta === 0 && b.maxEta === 0) return 'llegando';
  if (b.minEta === b.maxEta) return `${b.minEta} min`;
  return `${b.minEta ?? 0}–${b.maxEta} min`;
}

function humano(s) {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`;
}

function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}
