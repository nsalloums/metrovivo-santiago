// Escenarios de contingencia — SIMULADOS, no son el estado real de la red.
//
// Por qué no hay estado real: metrovivo se sirve como sitio estático, sin
// backend. Las dos fuentes posibles no sirven desde un navegador:
//
//   · metro.cl (`/api/estadoRedDetalle.php`) entrega datos reales y vigentes,
//     pero NO envía cabeceras CORS, así que el navegador no puede leerla
//     directamente. Requiere un proxy server-side.
//   · api.xor.cl (`/red/metro-network`) sí envía `access-control-allow-origin: *`,
//     pero es un scraper del HTML de `metro.cl/tu-viaje/estado-red`, página que
//     hoy responde 404. Devuelve siempre `{issues:false, lines:[]}` — es decir,
//     afirma "todo normal" incluso durante cierres reales.
//
// Un dato silenciosamente falso es peor que ningún dato, así que la capa en
// vivo se retiró. Ver README § "Estado de la red: por qué no es en vivo".
//
// Lo que sí queda es el motor de contingencias, que es lo interesante: estos
// escenarios se inyectan con `?estado=<nombre>` y la simulación reacciona de
// verdad (suspensiones, turnback en tramos cerrados, paso directo por
// estaciones cerradas). Ver `Simulation.applyEstado` en src/sim.js.
//
// Esquema (el mismo que consume applyEstado):
//   { lines: { <lineId>: { status, message, closedStations[], closedRanges[] } } }
//   status: 'normal' | 'partial' | 'suspended'
//   closedStations: ids de estación (slugs, como en data/network.json)

/** Escenario vacío: la red entera operativa. */
const NORMAL = { lines: {} };

export const SCENARIOS = {
  /** Todo operativo — útil para contrastar contra los demás escenarios. */
  'normal': NORMAL,

  /** Línea completa fuera de servicio: no salen trenes nuevos y los que
   *  están en viaje frenan en su próxima estación. */
  'l1-suspendida': {
    lines: {
      L1: {
        status: 'suspended',
        message: 'Servicio suspendido en toda la línea por falla técnica. Metro dispuso buses de apoyo en superficie.',
        closedStations: [],
        closedRanges: [],
      },
    },
  },

  /** Tramo cerrado (≥2 estaciones contiguas): la línea se parte en sub-líneas
   *  que hacen turnback en las fronteras del tramo. */
  'cierre-parcial': {
    lines: {
      L5: {
        status: 'partial',
        message: 'Servicio parcial: sin circulación entre Plaza de Maipú y Monte Tabor por persona en la vía. Trenes circulan en el resto de la línea.',
        closedStations: ['plaza-de-maipu', 'santiago-bueras', 'del-sol', 'monte-tabor'],
        closedRanges: [['plaza-de-maipu', 'monte-tabor']],
      },
    },
  },

  /** Estación suelta cerrada: los trenes la cruzan sin detenerse, reusando la
   *  física de paso directo de la operación expresa. */
  'estacion-cerrada': {
    lines: {
      L2: {
        status: 'partial',
        message: 'Estación Los Héroes cerrada temporalmente por manifestaciones en el exterior. Los trenes no se detienen en ella.',
        closedStations: ['los-heroes'],
        closedRanges: [],
      },
    },
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

/**
 * Resuelve `?estado=<nombre>` a un escenario.
 * @returns {{name: string, state: object} | null} null si no se pidió ninguno
 *   o si el nombre no existe (se ignora en silencio: es un parámetro de demo).
 */
export function scenarioFromQuery(search = location.search) {
  const name = new URLSearchParams(search).get('estado');
  if (!name) return null;
  const state = SCENARIOS[name];
  return state ? { name, state } : null;
}

/** Mensajes del escenario activo, en el formato que espera la UI. */
export function alertsOf(state) {
  return Object.entries(state?.lines || {})
    .filter(([, l]) => l.status !== 'normal')
    .map(([lineId, l]) => ({ lineId, status: l.status, message: l.message }));
}
