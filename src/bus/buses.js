// Orquestación de la capa de buses: carga perezosa, selección de paradero,
// sondeo y seguimiento de una patente por Santiago.
//
// DOS FUENTES, DOS REGÍMENES:
//
//   · MODO FLOTA — toda la ciudad a la vez. Sale del feed AVL de
//     velocidades.seguimos.cl: ~4.500 buses con GPS real, patente y hora de
//     medición POR BUS, en UNA petición por minuto. Es lo que hace posible
//     "todos los buses andando al mismo tiempo" sin barrer paraderos.
//
//   · PARADERO — llegadas de la API de RED (api.xor.cl), bajo demanda: el
//     paradero abierto y nada más. Un barrido de la ciudad con esta API sería
//     además falso: entrega sólo los ~2 buses siguientes por paradero, o sea
//     una MUESTRA presentada como flota.
//
// EL ENCADENADO (seguimiento por paradero, si la flota no trae la patente):
// cuando la patente desaparece del paradero actual es que ya pasó; se le
// pregunta al siguiente paradero del recorrido, que patterns.json conoce.
// Cada tramo queda confirmado por una MEDICIÓN, no por un reloj.

import { XorClient } from './xor-client.js';
import { BusStopProvider, ESTADOS } from './provider.js';
import { loadCatalog, loadNames } from './catalog.js';
import { BusPlacer } from './placement.js';
import { BusLayer } from './layer.js';
import { BusPanel } from './panel.js';
import { FleetClient, parseRouteCode } from './fleet-client.js';
import { FleetLayer } from './fleet-layer.js';
import { BusSim } from './bus-sim.js';
import { BusCab } from './bus-cab.js';

const REFRESCO_MS = 22000;   // paradero: el backend cambia de valor cada ~33 s
const PERDIDO_TRAS = 2;      // sondeos sin ver la patente antes de rendirse

export class Buses {
  constructor(scene, projection, { panelRoot, onEstado } = {}) {
    this.scene = scene;
    this.projection = projection;
    this.onEstado = onEstado || (() => {});
    this.client = new XorClient();
    this.provider = new BusStopProvider(this.client);
    this.panelRoot = panelRoot;

    this.cargado = false;
    this.activo = false;
    this.catalog = null;
    this.placer = null;
    this.layer = null;
    this.panel = null;

    this.stopIdx = -1;      // paradero abierto
    this.seguido = null;    // { plate, service, obs, fix, desde }
    this._timer = null;
    this._sinVer = 0;

    // modo flota
    this.fleetClient = new FleetClient();
    this.fleet = null;        // FleetLayer (perezoso)
    this._fleetTimer = null;
    this._rutasConocidas = null; // Set de route_id para etiquetar la flota
    this.busSel = null;       // { plate, bus } elegido en el mapa de flota (AVL)

    // dos fuentes de flota: 'sim' = itinerario oficial en movimiento continuo
    // (misma clase de dato que los trenes), 'avl' = GPS medido que envejece
    this.fuente = 'sim';
    this.sim = null;          // BusSim (perezoso)
    this.busSelSim = null;    // key del bus simulado elegido
    this.cab = null;          // BusCab: viajar dentro de un bus
    this.listaSim = [];       // flota simulada del frame (la usan cab y capa)
  }

  /** Carga los datos de buses la primera vez que se encienden. */
  async encender() {
    if (!this.cargado) {
      this.onEstado('cargando');
      this.catalog = await loadCatalog(this.projection);
      const [patterns, shapes] = await Promise.all([
        import('../../data/bus/patterns.json').then((m) => m.default),
        import('../../data/bus/shapes.json').then((m) => m.default),
      ]);
      await loadNames(this.catalog);
      this.placer = new BusPlacer(patterns, shapes, this.catalog, this.projection);
      this.layer = new BusLayer(this.scene, this.catalog);
      this.panel = new BusPanel(this.panelRoot, {
        onFollow: (plate, bus) => this.seguir(plate, bus),
        onClose: () => this.cerrarParadero(),
      });
      // modo flota: red de recorridos + flota simulada + flota medida
      this.fleet = new FleetLayer(this.scene, this.projection);
      this.fleet.construirRed(shapes.shapes);
      this._rutasConocidas = new Set(Object.keys(patterns.routes).map((r) => r.toUpperCase()));
      this.sim = new BusSim(patterns);
      this.cab = new BusCab(this.scene, this.placer, this.catalog, this.sim, () => this.listaSim);
      // al bajarse, la maqueta vuelve; main.js escucha 'bajado' para lo suyo
      this.cab.onExit = (motivo) => {
        this.fleet.setCabMode(false);
        if (this.activo) this.layer.setVisible(true);
        this.onEstado('bajado', { motivo });
      };
      this.cargado = true;
    }
    this.activo = true;
    this.layer.setVisible(true);
    this.fleet.setVisible(true);
    this.setFuente(this.fuente);
    this.onEstado('listo');
  }

  apagar() {
    this.activo = false;
    this.layer?.setVisible(false);
    this.fleet?.setVisible(false);
    this.seleccionarBus(null);
    clearTimeout(this._fleetTimer);
    this._fleetTimer = null;
    this.cerrarParadero();
    this.onEstado('apagado');
  }

  /** Cambia entre itinerario simulado y GPS medido. */
  setFuente(f) {
    this.fuente = f;
    this.seleccionarBus(null);
    if (!this.fleet) return;
    this.fleet.setFuente(f);
    if (f === 'avl') {
      this._sondearFlota(); // el GPS se pide solo cuando se mira
    } else {
      clearTimeout(this._fleetTimer);
      this._fleetTimer = null;
    }
    this.onEstado('fuente', { fuente: f });
  }

  setFade(f) { this.layer?.setFade(f); this.fleet?.setFade(f); }

  // ── modo flota ─────────────────────────────────────────────────────────
  async _sondearFlota() {
    // solo se pide GPS cuando el GPS está a la vista
    if (!this.activo || !this.fleet || this.fuente !== 'avl') return;
    const r = await this.fleetClient.query();
    if (!this.activo) return;
    if (r.ok) {
      this.fleet.setFlota(r.buses, r.fetchedAtWall);
      if (this.fleet.dropped) this.onEstado('flota-truncada', { dropped: this.fleet.dropped });
      this.onEstado('flota', { n: r.buses.size });
      // si hay un bus elegido, reanclarlo a su posición nueva
      if (this.busSel) {
        const p = this.fleet.posicionDe(this.busSel.plate);
        if (p) {
          this.busSel.bus = p.bus;
          this.fleet.seleccionar({ plate: this.busSel.plate, bus: p.bus, x: p.x, z: p.z });
          this.onEstado('bus-info', this.infoBusSel());
        }
      }
    } else if (r.reason !== 'muy-pronto' && r.reason !== 'pausado') {
      this.onEstado('flota-caida', { reason: r.reason });
    }
    clearTimeout(this._fleetTimer);
    // reprogramar cuando el cliente vuelva a permitirlo (+ pequeño margen)
    this._fleetTimer = setTimeout(() => this._sondearFlota(), this.fleetClient.espera() + 1500);
  }

  /** Bus más cercano a un punto de la escena, en la fuente visible. */
  busCerca(x, z, radio = 300) {
    if (!this.fleet || !this.fleet.visible) return null;
    return this.fuente === 'sim'
      ? this.fleet.cercanoSim(x, z, radio)
      : this.fleet.cercano(x, z, radio);
  }

  seleccionarBus(hit) {
    if (!hit) {
      this.busSel = null;
      this.busSelSim = null;
      this.fleet?.seleccionar(null);
      this.onEstado('bus-info', null);
      return;
    }
    if (hit.sim) {
      this.busSelSim = hit.key;
      this.busSel = null;
      this.fleet.seleccionar(hit); // el anillo lo reancla setSim() cada frame
      this.onEstado('bus-info', this.infoBusSel());
      return;
    }
    this.busSel = { plate: hit.plate, bus: hit.bus };
    this.busSelSim = null;
    this.fleet.seleccionar(hit);
    this.onEstado('bus-info', this.infoBusSel());
  }

  /** Datos del bus elegido, listos para pintar. Nunca mezcla estratos. */
  infoBusSel() {
    if (this.busSelSim) {
      const [route, dir] = this.busSelSim.split('|');
      return { sim: true, service: route, dir, nombre: this.placer.nombreServicio(route) };
    }
    if (!this.busSel?.bus) return null;
    const b = this.busSel.bus;
    const route = parseRouteCode(b.route, this._rutasConocidas);
    return {
      plate: this.busSel.plate, // patente: solo del bus elegido explícitamente
      service: route,
      routeCode: route ? null : b.route, // código interno si no hay servicio usuario
      dir: b.dir,
      speed: b.speed,
      edadS: Math.max(0, (Date.now() - b.ts) / 1000),
    };
  }

  /**
   * Sube a la cabina de un bus SIMULADO y viaja con él.
   * Sólo la fuente 'sim' se puede conducir: un bus del GPS es una foto de
   * hace ~33 s y viajar dentro exigiría inventar el movimiento intermedio.
   * → false si no se puede subir (fuente medida, o ya no circula a esa hora).
   */
  subirA(key, view, sec, day) {
    if (!this.cargado || this.fuente !== 'sim' || !this.cab) return false;
    if (!this.cab.enter(key, view, sec, day)) return false;
    this.seleccionarBus(null);
    this.fleet.setCabMode(true);   // la maqueta estorba a escala real
    this.layer.setVisible(false);
    this.onEstado('subido', this.infoViaje(view, null));
    return true;
  }

  bajar() { this.cab?.exit('usuario'); }

  /** Datos del viaje en curso, listos para el HUD de cabina. */
  infoViaje(_view, b) {
    if (!this.cab?.active) return null;
    const route = this.cab.route;
    // el destino sale del letrero oficial del viaje (trip_headsign), no del
    // nombre del último paradero: el bus dice "Peñalolen", no "Avenida Lo
    // Blanco / esq. J. Edwards Bello"
    const pat = this.placer.patterns[route]?.[this.cab.dir];
    return {
      service: route,
      nombre: this.placer.nombreServicio(route),
      dir: this.cab.dir,
      next: b ? this.catalog.name(b.nextStop) : null,
      nextCode: b ? this.catalog.code(b.nextStop) : null,
      etaNext: b ? b.etaNext : null,
      dest: pat?.dest || (b ? this.catalog.name(b.destStop) : null),
      circular: Boolean(pat?.circ),
      restantes: b ? b.restantes : null,
      totalStops: b ? b.totalStops : null,
      vKmh: b ? b.v * 3.6 : 0,
    };
  }

  /** Paradero más cercano a un punto de la escena (para el clic en el mapa). */
  paraderoCerca(x, z, radio = 500) {
    return this.catalog ? this.catalog.nearest(x, z, radio) : null;
  }

  abrirParadero(i) {
    if (!this.cargado || i < 0) return;
    this.stopIdx = i;
    this.seguido = null;
    this.layer.seleccionar(i);
    this.layer.ocultarBus();
    this.panel.abrir(this.catalog.code(i), this.catalog.name(i));
    this._reprogramar(0);
  }

  cerrarParadero() {
    this.stopIdx = -1;
    this.seguido = null;
    clearTimeout(this._timer);
    this._timer = null;
    this.layer?.seleccionar(null);
    this.layer?.ocultarBus();
    this.panel?.cerrar();
  }

  seguir(plate, bus) {
    if (!plate) {
      this.seguido = null;
      this.layer.ocultarBus();
      return;
    }
    this.seguido = { plate, service: bus.service, obs: [], fix: null, desde: Date.now(), stop: this.stopIdx };
    this._sinVer = 0;
    // el recorrido se dibuja de inmediato: es dato oficial, no depende de la API
    const dir = this.placer.sentido(bus.service, this.stopIdx);
    const shape = dir && this.placer.patterns[bus.service]?.[dir]?.shape;
    this.layer.mostrarRuta(shape ? this.placer.trazado(shape) : null);

    // Se ubica con la lectura que YA está en pantalla, no pidiendo otra: el
    // piso de 20 s por paradero acaba de marcarse con la consulta que pintó
    // este panel, así que una petición nueva devolvería 'muy-pronto' y el bus
    // se quedaría sin aparecer los primeros veinte segundos.
    const ultima = this.provider.ultima(this.catalog.code(this.stopIdx));
    if (ultima) this._actualizarSeguido(ultima);
  }

  _reprogramar(delay = REFRESCO_MS) {
    clearTimeout(this._timer);
    if (this.stopIdx < 0 || !this.activo) return;
    this._timer = setTimeout(() => this._sondear(), delay);
  }

  async _sondear() {
    if (!this.activo || this.stopIdx < 0) return;
    const code = this.catalog.code(this.seguido?.stop ?? this.stopIdx);
    const lectura = await this.provider.query(code);
    if (!this.activo || this.stopIdx < 0) return;

    // el panel siempre refleja el paradero ABIERTO, no el del seguimiento
    if ((this.seguido?.stop ?? this.stopIdx) === this.stopIdx) this.panel.render(lectura);

    if (this.seguido) this._actualizarSeguido(lectura);
    this._reprogramar();
  }

  _actualizarSeguido(lectura) {
    const s = this.seguido;
    const visto = lectura.buses.filter((b) => b.plate === s.plate && b.service === s.service);

    if (visto.length) {
      this._sinVer = 0;
      s.obs = visto.map((b) => ({
        stopCode: lectura.code, service: b.service, meters: b.meters,
      }));
      s.fix = this.placer.locate(s.obs);
      s.medidoEn = lectura.fetchedAtWall;
      this.onEstado('siguiendo', { plate: s.plate, fix: s.fix, service: s.service });
      return;
    }

    if (lectura.state !== ESTADOS.OK && lectura.state !== ESTADOS.SIN_DATOS) return; // fallo: no concluir nada

    // ya no se ve desde este paradero → preguntar al siguiente del recorrido
    this._sinVer++;
    const siguiente = this._siguienteParadero(s);
    if (siguiente >= 0) {
      s.stop = siguiente;
      this._sinVer = 0;
      this.onEstado('encadenando', { plate: s.plate, stop: this.catalog.code(siguiente) });
      return;
    }
    if (this._sinVer >= PERDIDO_TRAS) {
      this.onEstado('perdido', { plate: s.plate });
      this.seguido = null;
      this.layer.ocultarBus();
    }
  }

  /** Índice del paradero siguiente al actual en el recorrido del bus seguido. */
  _siguienteParadero(s) {
    const dir = this.placer.sentido(s.service, s.stop);
    const pat = dir && this.placer.patterns[s.service]?.[dir];
    if (!pat) return -1;
    const pos = pat.st.indexOf(s.stop);
    return pos >= 0 && pos + 1 < pat.st.length ? pat.st[pos + 1] : -1;
  }

  /**
   * Por frame. La flota simulada se recalcula entera aquí: su posición es una
   * función continua de la hora OFICIAL (sec, day vienen de SantiagoClock),
   * así que responde al scrubbing y a ×10/×60 igual que los trenes.
   */
  update(nowS, sec, day) {
    if (!this.activo) return;
    if (this.fuente === 'sim' && this.sim) {
      // la lista se calcula igual en cabina: de ahí salen los buses vecinos
      this.listaSim = this.sim.update(sec, day);
      if (this.fleet?.visible && !this.cab?.active) {
        this.fleet.setSim(this.listaSim, (shape, s) => this.placer.puntoEn(shape, s), this.busSelSim);
        if (this.fleet.simDropped) this.onEstado('flota-truncada', { dropped: this.fleet.simDropped });
      }
    }
    if (this.seguido?.fix?.ok) {
      const edad = Date.now() - (this.seguido.medidoEn || Date.now());
      this.layer.mostrarBus(this.placer, this.seguido.fix, edad);
      this.layer.pulso(nowS);
    }
  }

  /** A 1 Hz: la edad del dato es parte del dato — en el panel y en la flota. */
  tick() {
    this.panel?.actualizarEdad();
    if (this.fuente === 'avl') {
      this.fleet?.envejecer();
      if (this.busSel) this.onEstado('bus-info', this.infoBusSel());
    } else if (this.activo && this.fleet?.visible) {
      this.onEstado('flota', { n: this.fleet.simCount, sim: true });
    }
  }

  stats() { return { paradero: this.client.stats(), flota: this.fleetClient.stats() }; }
}
