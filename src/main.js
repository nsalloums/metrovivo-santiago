// metrovivo — orquestación: un solo renderer three.js, capas de red/trenes/
// contexto, simulación horaria y UI.

import './styles.css';
import * as THREE from 'three';
import data from '../data/network.json';
import { SantiagoClock } from './time.js';
import { NetworkLayer, RELIEVE_REAL } from './network.js';
import { TrainLayer } from './trains.js';
import { ContextLayer } from './context.js';
import { Simulation } from './sim.js';
import { ScheduleProvider } from './provider.js';
import { scenarioFromQuery, alertsOf } from './scenarios.js';
import { ViewManager } from './camera.js';
import { CabView } from './cab.js';
import { UI } from './ui.js';
import { REDUCED_MOTION } from './motion.js';
import { Buses } from './bus/buses.js';
import { gsap } from 'gsap';

// ── renderer ────────────────────────────────────────────────────────────────
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0c);
scene.fog = new THREE.Fog(0x0a0a0c, 55000, 140000); // metros

// ── capas ───────────────────────────────────────────────────────────────────
const clock = new SantiagoClock(data.calendar);
const network = new NetworkLayer(scene, data);
const context = new ContextLayer(scene, data);
const trains = new TrainLayer(scene, network);
// PositionProvider: hoy horario oficial; mañana, GTFS-RT (ver src/provider.js)
const sim = new ScheduleProvider(new Simulation(data));

// centro/tamaño de ambos espacios para el encuadre de cámara
function extents(get) {
  const b = new THREE.Box2();
  for (const st of Object.values(data.stations)) {
    const [x, y] = get(st);
    b.expandByPoint(new THREE.Vector2(x, -y));
  }
  const c = b.getCenter(new THREE.Vector2());
  const s = b.getSize(new THREE.Vector2());
  return { center: new THREE.Vector3(c.x, 0, c.y), size: s };
}
const geoExt = extents((st) => st.geo);
const schemExt = extents((st) => st.schem);

const view = new ViewManager(canvas, geoExt.center, geoExt.size, schemExt.center, schemExt.size);
const cab = new CabView(scene, network, sim, data);

// ── marcador de estación seleccionada ───────────────────────────────────────
const marker = new THREE.Mesh(
  new THREE.RingGeometry(200, 270, 32),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
);
marker.rotation.x = -Math.PI / 2;
marker.visible = false;
marker.renderOrder = 15;
scene.add(marker);
let markerPulse = null;

// ── UI ──────────────────────────────────────────────────────────────────────
let selectedStation = null;

const ui = new UI(data, {
  onToggleLine: (id, on) => network.setLineActive(id, on),
  onSelectStation: (id) => selectStation(id),
  onToggleMode: () => {
    if (view.transitioning || cab.active) return;
    const target = view.mode === '3d' ? '2d' : '3d';
    const tween = view.toggle((m) => {
      network.setMorph(m);
      context.setFade(1 - m);
      // los paraderos son geografía: no existen en el diagrama esquemático
      buses?.setFade(1 - m);
    });
    if (tween) ui.setMode(target);
  },
  onSpeed: (k) => { clock.setSpeed(k); ui.setLive(clock.isLive); },
  onTime: (sec) => { clock.setTime(sec); ui.setLive(false); },
  onLive: () => { clock.goLive(); ui.setLive(true); },
  onCabExit: () => { if (cab.active) cab.exit(); else buses?.bajar(); },
});
ui.setLive(clock.isLive);
// feriados (calendar_dates.txt) y vigencia del feed (feed_info.txt)
ui.setDatosAviso({ feriado: clock.feriado, vigencia: clock.vigencia() });

// ── vista de conductor ──────────────────────────────────────────────────────
const cabFade = { v: 1 }; // contexto y discos de estación se ocultan bajo tierra
function enterCab(train) {
  if (cab.active || view.transitioning || view.mode !== '3d' || view.blend > 0.05) return;
  trains.hideKey = train.key;
  ui.hideTooltip();
  // placas de andén con clasificación R/V/C si la ventana expresa está vigente
  const line = data.lines.find((l) => l.id === train.lineId);
  const expressInfo = sim.expressActive(train.lineId, clock.sec(), clock.day)
    ? { class: line.express.class } : null;
  cab.enter(train, view, expressInfo);
  ui.cabShow(train.lineId);
  gsap.killTweensOf(cabFade);
  gsap.to(cabFade, {
    v: 0, duration: 1.2, ease: 'power2.in',
    onUpdate: () => {
      context.setFade(cabFade.v);
      // angostar las cintas a piso de túnel real (~6 m) y atenuarlas; el
      // relieve pasa de maqueta (×26) a metros de verdad por la misma razón
      network.widthScale = 0.055 + 0.945 * cabFade.v;
      network.relieve = RELIEVE_REAL + (1 - RELIEVE_REAL) * cabFade.v;
      network.setGlobalDim(0.3 + 0.7 * cabFade.v);
      network.setMorph(0);
    },
    onComplete: () => { network.dots.visible = network.rings.visible = false; marker.visible = false; },
  });
}
cab.onExit = () => {
  trains.hideKey = null;
  cabAlerted = false;
  ui.cabHide();
  network.dots.visible = network.rings.visible = true;
  if (selectedStation) marker.visible = true;
  gsap.killTweensOf(cabFade);
  gsap.to(cabFade, {
    v: 1, duration: 1.2, ease: 'power2.out',
    onUpdate: () => {
      context.setFade(cabFade.v);
      network.widthScale = 0.055 + 0.945 * cabFade.v;
      network.relieve = RELIEVE_REAL + (1 - RELIEVE_REAL) * cabFade.v;
      network.setGlobalDim(0.3 + 0.7 * cabFade.v);
      network.setMorph(0);
    },
  });
};

// Subirse a un bus del itinerario. Mismo gesto que con un tren: un clic. La
// maqueta (buses de 34 m, red flotando) se apaga y BusCab levanta la calle a
// escala real — ver src/bus/bus-cab.js.
// → false si no se pudo subir (transición de vista, o el bus ya llegó): quien
// llama cae entonces a seleccionarlo, para que el clic nunca quede en nada.
function entrarBusCab(hit) {
  if (!buses || cab.active || buses.cab?.active) return false;
  if (view.transitioning || view.mode !== '3d' || view.blend > 0.05) return false;
  return buses.subirA(hit.key, view, clock.sec(), clock.day);
}

// ── escenarios de contingencia (simulados) ──────────────────────────────────
// ?estado=<nombre> inyecta un escenario: normal, l1-suspendida,
// cierre-parcial, estacion-cerrada. NO es el estado real de la red — ver
// src/scenarios.js para por qué la capa en vivo no existe.
const scenario = scenarioFromQuery();
let estadoLines = {}; // líneas afectadas por el escenario, para UI/cabina
let cabAlerted = false;

if (scenario) {
  estadoLines = scenario.state.lines || {};
  const closedIds = [];
  for (const l of data.lines) {
    const st = estadoLines[l.id];
    network.setLineStatus(l.id, st?.status || 'normal');
    if (st) closedIds.push(...st.closedStations);
  }
  network.setClosedStations(closedIds);
  // sec = 0: la contingencia se asume preexistente al cargar la página
  sim.applyEstado(scenario.state, 0);
  ui.setScenarioChip(scenario.name);
  ui.setContingencia(alertsOf(scenario.state));
}

// ── capa de buses (datos REALES, a diferencia de todo lo demás) ─────────────
// Puerta dura: con el dataset de ejemplo las estaciones tienen coordenadas
// aproximadas (~640 m de desviación mediana) y los paraderos del GTFS son de
// precisión métrica. Superponerlos crea un desalineamiento que el visitante no
// puede diagnosticar, así que la capa sencillamente no se ofrece.
const BUSES_DISPONIBLES = data.meta?.source !== 'sample';
const busBtn = document.getElementById('bus-toggle');
let buses = null;

if (!BUSES_DISPONIBLES) {
  busBtn.hidden = true;
  document.getElementById('closed-to-buses').hidden = true;
} else {
  const flotaN = document.getElementById('bus-count');
  buses = new Buses(scene, data.projection, {
    panelRoot: document.getElementById('bus-panel'),
    onEstado: (estado, info) => {
      busBtn.dataset.estado = estado;
      if (estado === 'cargando') busBtn.classList.add('is-loading');
      if (estado === 'listo' || estado === 'apagado') busBtn.classList.remove('is-loading');
      if (estado === 'perdido' && info) ui.setBusAviso(`Perdimos el rastro del bus ${info.plate}`);
      if (estado === 'encadenando' && info) ui.setBusAviso(`Ya pasó — preguntando al paradero ${info.stop}`);
      if (estado === 'siguiendo') ui.setBusAviso(null);
      if (estado === 'flota' && info) {
        flotaN.textContent = info.sim
          ? `${info.n.toLocaleString('es-CL')} buses según itinerario`
          : `${info.n.toLocaleString('es-CL')} buses medidos`;
      }
      if (estado === 'fuente' && info) {
        for (const o of fuenteBtn.querySelectorAll('.opt')) {
          o.classList.toggle('active', o.dataset.src === info.fuente);
        }
        flotaN.textContent = '';
      }
      if (estado === 'flota-caida') ui.setBusAviso('El feed de flota no responde — se muestra la última foto');
      if (estado === 'flota-truncada' && info) ui.setBusAviso(`Capa llena: ${info.dropped} buses no dibujados`);
      if (estado === 'bus-info') ui.setBusInfo(info);
      if (estado === 'subido' && info) {
        // el metro entra a la cabina de un tren; acá, a la de un bus
        ui.hideTooltip();
        ui.setBusInfo(null);
        ui.cabShowBus(info);
        gsap.killTweensOf(cabFade);
        gsap.to(cabFade, {
          v: 0, duration: 1.2, ease: 'power2.in',
          onUpdate: () => { context.setFade(cabFade.v); network.dimStations(0.3 * cabFade.v); },
          onComplete: () => { network.dots.visible = network.rings.visible = false; marker.visible = false; },
        });
      }
      if (estado === 'bajado') {
        ui.cabHide();
        network.dots.visible = network.rings.visible = true;
        if (selectedStation) marker.visible = true;
        gsap.killTweensOf(cabFade);
        gsap.to(cabFade, {
          v: 1, duration: 1.2, ease: 'power2.out',
          onUpdate: () => { context.setFade(cabFade.v); network.dimStations(0.3 * cabFade.v); },
        });
        if (info?.motivo === 'terminal') ui.setBusAviso('El bus llegó a su terminal');
      }
    },
  });

  // "o elijo metro o elijo buses": en modo buses las CINTAS del metro
  // desaparecen del todo (dos redes superpuestas no se leen) y los trenes se
  // ocultan; los discos de estación quedan, atenuados, como referencia urbana.
  const setTrainsVisible = (on) => {
    for (const m of [trains.mesh, trains.lights, trains.flags, trains.trails]) m.visible = on;
  };
  const fuenteBtn = document.getElementById('bus-source');
  const aplicarModo = (busesOn) => {
    network.setRibbonsVisible(!busesOn);
    network.dimStations(busesOn ? 0.3 : 1);
    setTrainsVisible(!busesOn);
    ui.setTrainCountVisible?.(!busesOn);
    fuenteBtn.hidden = !busesOn;
  };

  busBtn.addEventListener('click', async () => {
    const encender = busBtn.getAttribute('aria-pressed') !== 'true';
    busBtn.setAttribute('aria-pressed', String(encender));
    busBtn.classList.toggle('is-on', encender);
    if (encender) {
      try {
        await buses.encender();
        buses.setFade(1 - view.blend);
        aplicarModo(true);
        refreshClosed(); // el cartel de cierre es del metro: en modo buses no existe
      } catch (e) {
        busBtn.setAttribute('aria-pressed', 'false');
        busBtn.classList.remove('is-on', 'is-loading');
        ui.setBusAviso('No se pudieron cargar los datos de paraderos');
        console.error(e);
      }
    } else {
      buses.apagar();
      aplicarModo(false);
      flotaN.textContent = '';
      ui.setBusAviso(null);
      ui.setBusInfo(null);
      refreshClosed(); // de vuelta al metro: si está cerrado, el cartel vuelve
    }
  });

  // el propio cartel de cierre ofrece la salida: pasar al modo buses
  document.getElementById('closed-to-buses').addEventListener('click', () => busBtn.click());

  // sub-modo: itinerario simulado (en movimiento) ↔ GPS medido (envejece)
  fuenteBtn.addEventListener('click', () => {
    if (!buses.cargado) return;
    buses.setFuente(buses.fuente === 'sim' ? 'avl' : 'sim');
  });
}

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (cab.active) cab.exit();
    else if (buses?.cab?.active) buses.bajar();
  }
  // no interceptar la D si se está escribiendo en un control
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '');
  if ((e.key === 'd' || e.key === 'D') && !e.metaKey && !e.ctrlKey && !typing) ui.toggleDebug();
});

// triple-tap en el canvas: overlay de debug también accesible en móvil
// (ventana por intervalo entre taps, tolerante a dispositivos lentos)
let tapCount = 0, lastTap = 0;
canvas.addEventListener('pointerdown', () => {
  const now = performance.now();
  tapCount = now - lastTap < 450 ? tapCount + 1 : 1;
  lastTap = now;
  if (tapCount >= 3) { tapCount = 0; ui.toggleDebug(); }
});

function selectStation(id) {
  selectedStation = id;
  ui.selectStation(id);
  if (id) {
    marker.visible = true;
    const c = data.lines.find((l) => l.id === data.stations[id].lines[0]).color;
    marker.material.color.set(c);
    markerPulse?.kill();
    if (!REDUCED_MOTION) {
      markerPulse = gsap.fromTo(marker.scale, { x: 0.6, y: 0.6, z: 0.6 }, {
        x: 1, y: 1, z: 1, duration: 0.9, ease: 'sine.inOut', repeat: -1, yoyo: true,
      });
    }
    refreshArrivals();
  } else {
    marker.visible = false;
    markerPulse?.kill();
  }
}

// ── picking: placa de andén al pasar/tocar ──────────────────────────────────
const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hoverId = null;
let pointerPx = { x: 0, y: 0 };
let pointerDirty = false;

canvas.addEventListener('pointermove', (e) => {
  pointerPx = { x: e.clientX, y: e.clientY };
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  pointerDirty = true;
});
// seleccionar en pointerup solo si no hubo arrastre (órbita/pan)
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (cab.active || buses?.cab?.active) return;
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  downAt = null;
  if (buses?.activo) {
    // modo buses: bus de la flota → paradero → estación; los trenes están
    // ocultos y no se pican (el raycaster de three no respeta .visible)
    const bus = pickBusFlota();
    // un bus del itinerario se conduce (como un tren); uno medido sólo se mira
    if (bus?.sim && entrarBusCab(bus)) return;
    if (bus) { buses.seleccionarBus(bus); return; }
    const paradero = pickParadero();
    if (paradero >= 0) { buses.seleccionarBus(null); buses.abrirParadero(paradero); return; }
    buses.seleccionarBus(null); // clic al vacío: deseleccionar
    const hit = pick();
    if (hit) selectStation(hit === selectedStation ? null : hit);
    return;
  }
  // modo metro: tren exacto (raycast instanceId) → estación → tren cercano
  const train = pickTrain();
  if (train) { enterCab(train); return; }
  const hit = pick();
  if (hit) { selectStation(hit === selectedStation ? null : hit); return; }
  const near = trains.nearestOnScreen(e.clientX, e.clientY, view.camera, 24);
  if (near) enterCab(near);
});

function pick() {
  ray.setFromCamera(pointer, view.camera);
  ray.params.Mesh = { threshold: 0 };
  const hits = ray.intersectObject(network.dots);
  if (!hits.length) return null;
  return network.stationIds[hits[0].instanceId];
}

/**
 * Paradero bajo el puntero. Los discos son diminutos a escala de ciudad, así
 * que el raycast directo casi nunca acierta: se proyecta el rayo al plano de
 * los paraderos y se busca el más cercano a ese punto, con una tolerancia
 * que depende del zoom (a más lejos, más metros por píxel).
 */
function pickParadero() {
  if (!buses?.activo || !buses.cargado || view.blend > 0.05) return -1;
  ray.setFromCamera(pointer, view.camera);
  const p = _v3;
  if (!ray.ray.intersectPlane(_planoParaderos, p)) return -1;
  // ~24 px de tolerancia convertidos a metros a esa distancia de la cámara
  const dist = view.camera.position.distanceTo(p);
  const porPixel = view.mode === '2d'
    ? (view.camera.top - view.camera.bottom) / innerHeight
    : (2 * Math.tan((view.camera.fov * Math.PI) / 360) * dist) / innerHeight;
  const r = Math.min(1200, Math.max(120, porPixel * 24));
  const hit = buses.paraderoCerca(p.x, p.z, r);
  return hit ? hit.i : -1;
}

/** Bus de la flota bajo el puntero (mismo truco de plano + tolerancia por zoom). */
function pickBusFlota() {
  if (!buses?.cargado || view.blend > 0.05) return null;
  ray.setFromCamera(pointer, view.camera);
  const p = _v3;
  if (!ray.ray.intersectPlane(_planoFlota, p)) return null;
  const dist = view.camera.position.distanceTo(p);
  const porPixel = view.mode === '2d'
    ? (view.camera.top - view.camera.bottom) / innerHeight
    : (2 * Math.tan((view.camera.fov * Math.PI) / 360) * dist) / innerHeight;
  const r = Math.min(900, Math.max(90, porPixel * 20));
  return buses.busCerca(p.x, p.z, r);
}

function pickTrain() {
  if (view.mode !== '3d' || view.blend > 0.05) return null;
  ray.setFromCamera(pointer, view.camera);
  const hits = ray.intersectObject(trains.mesh);
  return hits.length ? trains.instanceTrain[hits[0].instanceId] : null;
}

const _v3 = new THREE.Vector3();
const _planoParaderos = new THREE.Plane(new THREE.Vector3(0, 1, 0), -90); // y = 90, cota de los discos
const _planoFlota = new THREE.Plane(new THREE.Vector3(0, 1, 0), -60);     // y = 60, cota de los buses

function updateHover() {
  if (!pointerDirty || view.transitioning) return;
  pointerDirty = false;
  const id = pick();
  if (id !== hoverId) {
    hoverId = id;
    canvas.style.cursor = id ? 'pointer' : 'grab';
  }
}

function updateTooltip() {
  if (!hoverId || view.transitioning) { ui.hideTooltip(); return; }
  // anclar la placa a la estación (se mueve con morph/cámara)
  _v3.copy(network.stationPosition(hoverId)).project(view.camera);
  if (_v3.z > 1) { ui.hideTooltip(); return; }
  // clasificación R/V/C visible solo durante horario expreso
  const xcls = [];
  const sec = clock.sec();
  for (const lid of data.stations[hoverId].lines) {
    if (sim.expressActive(lid, sec, clock.day)) {
      const line = data.lines.find((l) => l.id === lid);
      xcls.push({ lineId: lid, cls: line.express.class[hoverId] || 'C' });
    }
  }
  // estación cerrada por contingencia → placa gris
  const closed = network.closedSet?.has(hoverId) || false;
  ui.showTooltip(hoverId, (_v3.x * 0.5 + 0.5) * innerWidth, (-_v3.y * 0.5 + 0.5) * innerHeight, xcls, closed);
}

// ── loop ────────────────────────────────────────────────────────────────────
let lastTick = -1;
let lastFrame = performance.now();
let fpsAcc = 0, fpsFrames = 0, fps = 0;
let cabTrain = null;
let cabBus = null;

// El cartel "Metro cerrado" es un hecho del metro, no de la ciudad: solo
// existe en modo metro. En modo buses la capa activa son mediciones reales de
// una flota que sí circula de madrugada, y el cartel además taparía el botón
// para volver (es un overlay de pantalla completa por encima del HUD).
function refreshClosed(sec = clock.sec()) {
  const open = sim.serviceOpen(sec, clock.day);
  const mostrar = !open && !buses?.activo;
  ui.setClosed(mostrar, mostrar ? sim.nextOpening(sec, clock.day) : null);
}

function refreshArrivals() {
  if (!selectedStation) return;
  // aviso de contingencia de las líneas de la estación (como letrero real)
  let alertMsg = null;
  const st = data.stations[selectedStation];
  for (const lid of st.lines) {
    const e = estadoLines[lid];
    if (!e || e.status === 'normal') continue;
    if (e.closedStations.includes(selectedStation)) {
      alertMsg = 'Estación cerrada — los trenes no se detienen';
      break;
    }
    alertMsg = e.message || 'Servicio con alteraciones';
  }
  ui.updateArrivals(sim.arrivals(selectedStation, clock.sec(), clock.day), alertMsg);
}

function debugText(sec) {
  const perLine = {};
  let nR = 0, nV = 0;
  for (const t of sim.trains) {
    perLine[t.lineId] = (perLine[t.lineId] || 0) + 1;
    if (t.pattern === 'R') nR++;
    else if (t.pattern === 'V') nV++;
  }
  const lines = data.lines.map((l) => `${l.id}:${perLine[l.id] || 0}`).join('  ');
  return [
    `hora  ${clock.hms()}  (${clock.day}${clock.feriado ? ' feriado' : ''})  ×${clock.speed}${clock.isLive ? '  EN VIVO' : '  DEMO'}`,
    `feed  ${data.calendar?.version || '?'}  ${data.calendar?.start || '?'}–${data.calendar?.end || '?'}${clock.vigencia() ? '  VENCIDO' : ''}`,
    `fps   ${fps.toFixed(0)}   trenes ${sim.trains.length} (${trains.visibleCount} visibles)`,
    `${lines}`,
    `expresos  R:${nR}  V:${nV}`,
    `escenario  ${scenario ? scenario.name : 'ninguno (red operativa)'}`,
    `modo  ${cab.active ? 'cabina' : buses?.cab?.active ? `cabina-bus ${buses.cab.route}` : view.mode}   morph ${view.blend.toFixed(2)}`,
  ].join('\n');
}

function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  const dt = Math.min(0.1, (nowMs - lastFrame) / 1000);
  lastFrame = nowMs;
  const sec = clock.sec();

  sim.update(sec, clock.day);
  trains.update(sim.trains, view.blend, dt, nowMs / 1000, cab.active ? cab.blend : 0);

  if (selectedStation) {
    const p = network.stationPosition(selectedStation);
    marker.position.set(p.x, p.y + 20, p.z);
  }

  // antes del bloque de cámara: la cabina del bus lee de aquí sus vecinos
  buses?.update(nowMs / 1000, sec, clock.day);

  let camera;
  if (cab.active) {
    cabTrain = cab.update(dt); // el HUD textual se refresca a 1 Hz en el tick
    if (cabTrain) ui.cabSpeed(cabTrain.vKmh || 0); // velocímetro por frame
    camera = cab.active ? cab.cam : view.camera;
  } else if (buses?.cab?.active) {
    cabBus = buses.cab.update(dt, sec, clock.day);
    if (cabBus) ui.cabSpeed(cabBus.v * 3.6); // velocidad del tramo, en km/h
    camera = buses.cab.active ? buses.cab.cam : view.camera;
  } else {
    updateHover();
    updateTooltip();
    view.update();
    camera = view.camera;
  }
  network.pulseSuspended(nowMs / 1000);
  renderer.render(scene, camera);

  // FPS (ventana de 0.5 s); el texto de debug se arma a 1 Hz en el tick
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 0.5) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }

  // tareas de 1 Hz (en tiempo simulado)
  const tick = Math.floor(sec);
  if (tick !== lastTick) {
    lastTick = tick;
    ui.setClock(clock.hms());
    ui.setTrainCount(trains.visibleCount);
    ui.reflectTime(sec);
    refreshArrivals();
    buses?.tick(); // la edad del dato real se cuenta con el reloj de pared
    if (buses?.cab?.active && cabBus) ui.cabUpdateBus(buses.infoViaje(view, cabBus));
    if (cab.active && cabTrain) {
      if (!cabAlerted) ui.cabUpdate({ ...cabTrain, hms: clock.hms(), skips: sim.skipsBefore(cabTrain) });
      // si tu tramo se suspende: aviso y salida elegante a la órbita
      const st = estadoLines[cab.lineId]?.status;
      if ((st === 'suspended' || st === 'partial' || cabTrain.frozen) && !cabAlerted) {
        cabAlerted = true;
        ui.cabServiceAlert();
        setTimeout(() => { if (cab.active) cab.exit(); }, 2400);
      }
    }
    if (ui.debugVisible) ui.setDebug(debugText(sec));
    refreshClosed(sec);
  }
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  view.resize();
  for (const c of [cab.cam, buses?.cab?.cam]) {
    if (!c) continue;
    c.aspect = innerWidth / innerHeight;
    c.updateProjectionMatrix();
  }
});

view.resize();
frame();

// hook de depuración/demo (usado también por las pruebas de aceptación)
window.metrovivo = { clock, sim, view, cab, network, trains, enterCab, scenario, buses, scene, renderer, ui };
