// PositionProvider: la costura para el día en que existan posiciones reales.
//
// Todo lo que está fuera del provider (render, cabina, LED, UI) consume este
// contrato y NO sabe de dónde vienen las posiciones. Hoy la única
// implementación es ScheduleProvider — f(hora oficial) → posiciones vía el
// motor determinista (src/sim.js). El día que Metro/DTPM publique GTFS-RT
// VehiclePositions (o exista un convenio), se agrega un RealtimeProvider con
// el mismo contrato; ver README § "Arquitectura para tiempo real".
//
// Contrato (por frame):
//   update(sec, day)      → Train[]  (pool interno, no retener referencias)
//   trains                → Train[]  último resultado
//   byKey: Map<key,Train> → identidad estable por tren dentro del día
//   byId:  Map<lineId, LineRuntime> → datos estáticos/horario por línea
// Train: { key, lineId, dir, moving, frozen?, pattern, sGeo, sSchem,
//          next, etaNext, dwell, dwellRemain, vKmh, dest, gA, gB }
// Consultas: arrivals(stationId, sec, day), skipsBefore(train),
//   expressActive(lineId, sec, day), serviceOpen(sec, day),
//   nextOpening(sec, day), applyEstado(escenario, sec).

export class ScheduleProvider {
  constructor(sim) {
    this._engine = sim;
  }

  /** Posiciones = f(hora oficial en America/Santiago). */
  update(sec, day) { return this._engine.update(sec, day); }

  get trains() { return this._engine.trains; }
  get byKey() { return this._engine.byKey; }
  get byId() { return this._engine.byId; }

  arrivals(stationId, sec, day, perDir, horizon) {
    return this._engine.arrivals(stationId, sec, day, perDir, horizon);
  }

  skipsBefore(train) { return this._engine.skipsBefore(train); }
  expressActive(lineId, sec, day) { return this._engine.expressActive(lineId, sec, day); }
  serviceOpen(sec, day) { return this._engine.serviceOpen(sec, day); }
  nextOpening(sec, day) { return this._engine.nextOpening(sec, day); }

  /** Un escenario de contingencia modula al horario (suspensiones, cierres). */
  applyEstado(state, sec) { return this._engine.applyEstado(state, sec); }
}
