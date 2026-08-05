# Marcas, datos y atribución

metrovivo **no está afiliado** a Metro de Santiago S.A. ni a la Dirección de
Transporte Público Metropolitano (DTPM).

- **Marcas.** "Metro", "Metro de Santiago", "Ruta Roja" y "Ruta Verde" son marcas de
  sus respectivos titulares. El logotipo oficial de Metro es marca registrada y **no
  se usa** en este proyecto: el isotipo (rombo rojo con el centro vaciado) es
  original. Los colores de línea son aproximaciones ajustadas a ojo contra el plano
  público, no valores oficiales de marca.

- **Datos de la red.** Provienen del GTFS público publicado por DTPM en
  [dtpm.cl](https://www.dtpm.cl/index.php/noticias/gtfs-vigente) — red de metro,
  catálogo de paraderos y trazados de recorridos. El dataset de ejemplo de
  `scripts/sample-data.mjs` es un respaldo para correr sin feed; sus coordenadas se
  desvían una mediana de 636 m y hasta 4,1 km, y con él la capa de buses queda
  deshabilitada.

- **Posiciones de flota en vivo.** El modo flota consulta
  [velocidades.seguimos.cl](https://velocidades.seguimos.cl), un servicio comunitario
  que publica el AVL de la flota de Red Movilidad. metrovivo no está afiliado a él, no
  hay términos de uso publicados ni garantía de continuidad, y el sondeo está limitado
  a una petición por minuto con la pestaña visible (`src/bus/fleet-client.js`). Las
  posiciones son GPS reportado con su hora de medición; la edad del dato se muestra
  siempre.

- **Llegadas de buses en vivo.** Se consultan a
  [api.xor.cl](https://api.xor.cl) (`/red/bus-stop/{código}`), un proyecto
  comunitario independiente que expone el predictor de Red Movilidad. metrovivo no
  está afiliado a él, y su disponibilidad no está garantizada. El sondeo es bajo
  demanda y con límite de tasa (`src/bus/xor-client.js`) para no cargar un servicio
  que mantiene una sola persona.

- **Patentes de buses.** Se muestran únicamente en el vehículo que la persona elige
  seguir, y con un fin concreto: hacer verificable el seguimiento. **No deben usarse
  para derivar métricas de puntualidad, velocidad o conducción**, ni para hacer
  seguimiento sostenido de un vehículo o de quien lo conduce.

- **Posiciones de los buses.** La distancia y la hora de llegada son mediciones
  reales de RED. La posición dibujada sobre el mapa es una **inferencia** a partir de
  esa distancia y del trazado oficial, con un error que no se ha podido validar mejor
  que a varios cientos de metros. No deben usarse para planificar viajes.

- **Posiciones de los trenes.** Son una **simulación** calculada a partir de horarios
  y frecuencias publicadas. Metro de Santiago no publica posiciones de vehículos en
  tiempo real, y este proyecto no las obtiene de ninguna parte. No deben usarse para
  planificar viajes.

- **Clasificación expresa.** El contenido de `express-config.json` es una
  aproximación manual al esquema Ruta Roja/Verde conocido a enero de 2026, no una
  fuente autoritativa. Contrastar con [metro.cl](https://www.metro.cl).

- **Tipografías.** [Hind](https://fonts.google.com/specimen/Hind) y
  [VT323](https://fonts.google.com/specimen/VT323) se cargan desde Google Fonts bajo
  la SIL Open Font License 1.1.

El código de este repositorio se distribuye bajo la licencia [MIT](LICENSE).
