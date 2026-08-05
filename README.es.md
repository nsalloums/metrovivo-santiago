[English](README.md) · **Español**

<div align="center">

<img src="docs/hero-3d.png" alt="La red del Metro de Santiago en 3D, siete líneas de colores sobre una grilla urbana oscura, 150 trenes a las 08:15" width="820">

# metrovivo

**La red del Metro de Santiago en 3D y 2D — cada tren moviéndose en sincronía con el horario oficial.**

[![Deploy](https://github.com/nsalloums/metrovivo-santiago/actions/workflows/deploy.yml/badge.svg)](https://github.com/nsalloums/metrovivo-santiago/actions/workflows/deploy.yml)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)
[![three.js](https://img.shields.io/badge/three.js-r178-black.svg)](https://threejs.org)
[![Demo en vivo](https://img.shields.io/badge/demo-en%20vivo-E2231A.svg)](https://nsalloums.github.io/metrovivo-santiago/)

### [→ Abrir la demo](https://nsalloums.github.io/metrovivo-santiago/)

</div>

---

Siete líneas, 126 estaciones, 146 trenes en la punta de la mañana — y, si enciendes
los buses, 5.700 más. La posición de cada
tren es una **función determinista de la hora actual en `America/Santiago`** — derivada
de las frecuencias publicadas y de un perfil de velocidad físico, no de una animación
al azar. Haz click en cualquier tren y la cámara vuela hasta su cabina.

Sin tiles de mapa, sin servicios externos, sin backend. Un solo renderer de three.js
dibuja todo.

> [!NOTE]
> **Son posiciones simuladas, no reales.** Metro de Santiago no publica posiciones de
> vehículos en vivo, así que metrovivo calcula dónde *debería* estar cada tren según el
> horario. Ver [Por qué no hay datos en vivo del metro](#por-qué-no-hay-datos-en-vivo-del-metro) — es la
> restricción más interesante del proyecto.

## Partir rápido

```bash
npm install
npm run dev
```

Y abres la URL que imprime Vite. Eso es todo: sin API keys, sin `.env`, sin servicios
que levantar.

```bash
npm test      # 118 tests unitarios (Vitest)
npm run build
npm run smoke # 17 checks headless contra el build real (Playwright)
```

## Qué se puede hacer

| | |
|---|---|
| <img src="docs/cabina.png" alt="Vista de conductor dentro de un túnel iluminado en rojo, HUD con próxima estación Los Dominicos y 65 km/h" width="420"> | **Ir en la cabina.** Haces click en un tren y la cámara se acopla a su parabrisas. El túnel es procedural — anillos, luces de pared y durmientes pasan a un ritmo acorde a la velocidad simulada. El HUD muestra la próxima estación, cuenta regresiva y la velocidad del perfil físico. |
| 🚌 | **Subirte a un bus.** En modo BUSES, un clic sobre cualquier bus del itinerario te mete en su cabina: calzada, soleras, eje segmentado y luminarias a escala real, y cada paradero con su nombre oficial en el letrero. Los buses medidos por GPS no se conducen — son una foto de hace 33 s y el movimiento intermedio habría que inventarlo. |
| ⛰ | **Ver el relieve real de la red.** Las líneas ya no van planas: cada andén se dibuja a su nivel según `levels.txt`, así que el viaducto de L5 se eleva sobre la ciudad y L3 se hunde bajo Plaza de Armas. El orden de niveles es dato medido; la separación, escala de maqueta — y dentro de la cabina se retira para dejar los metros de verdad. |
| <img src="docs/diagrama-2d.png" alt="La misma red transformada en diagrama esquemático con ángulos de 0, 45 y 90 grados" width="420"> | **Transformar geografía en el plano oficial.** Cada estación guarda dos posiciones: sus coordenadas reales y una esquemática a 0/45/90°. El cambio es un lerp vértice a vértice, así que las estaciones nunca se deslizan. |
| <img src="docs/panel-led.png" alt="Pantalla de andén punto-matriz ámbar con los próximos cinco trenes en Baquedano" width="420"> | **Leer la pantalla de andén.** Un panel punto-matriz ámbar lista las próximas llegadas de cualquier estación, derivadas del mismo calendario de salidas que mueve a los trenes — por eso siempre coincide con lo que ves. |
| <img src="docs/escenario-suspension.png" alt="Línea 1 atenuada en gris durante una suspensión simulada" width="420"> | **Romper la red a propósito.** `?estado=l1-suspendida` suspende una línea: no salen trenes nuevos, los que van en viaje frenan en su próxima estación y la línea se pinta gris. Otros escenarios cierran una estación o un tramo entero. |

Parámetros de depuración: `?t=08:30` fija la hora, `?day=wd\|sa\|su` fuerza el tipo de
día, `?estado=<escenario>` inyecta una contingencia. Tecla <kbd>D</kbd> (o triple-tap)
para el overlay de debug.

## Cómo funciona

```mermaid
flowchart LR
  A["GTFS de dtpm.cl<br/><i>o dataset de ejemplo</i>"] --> B["scripts/build-data.js"]
  B --> C["data/network.json<br/><i>110 KB</i>"]
  C --> D["Simulation<br/><i>f(hora, tipo de día)</i>"]
  D --> E["PositionProvider"]
  E --> F["Red · Trenes · Cabina · LED"]
  style D fill:#E2231A,color:#fff
  style E fill:#2B3990,color:#fff
```

`Simulation` es una función pura — sin DOM, sin renderer — y por eso todo el motor es
testeable unitariamente. `PositionProvider` es la costura: todo lo que está aguas abajo
consume ese contrato y no sabe de dónde vienen las posiciones.

<details>
<summary><b>La física: por qué los trenes aceleran en vez de hacer easing</b></summary>

<br>

Cada tramo entre estaciones usa un **perfil de velocidad trapezoidal** — acelerar a
~1 m/s², crucero, frenar — resuelto en forma cerrada para que el tren cubra exactamente
*D* metros en los *T* segundos que le da el horario. El crucero tiene clamp a 80 km/h;
si se activa, se recalcula la aceleración para seguir llegando puntual.

La implementación anterior usaba easing senoidal, que nunca *sostiene* una velocidad:
llega a un pico y frena de inmediato. Un metro real mantiene crucero la mayor parte del
tramo:

| Tramo L1 | Largo | Tiempo | Media | Pico senoidal | Crucero trapezoidal |
|---|---|---|---|---|---|
| República → Los Héroes | 355 m | 45 s | 28,4 km/h | 42,6 km/h | 36,7 km/h |
| Baquedano → Salvador | 931 m | 67 s | 50,0 km/h | 75,0 km/h | 70,9 km/h sostenido |
| Escuela Militar → Manquehue | 1385 m | 100 s | 50,0 km/h | 75,0 km/h | 60,1 km/h sostenido |

La media no cambia — la fija el horario. Lo que cambia es la *forma*, y eso es lo que se
siente en la cabina.

**1 unidad = 1 metro** en toda la app. La proyección local se auditó contra la distancia
haversine: 0,05 % de error en San Pablo↔Los Dominicos (16 177 m vs 16 185 m). Se
reproduce con `node scripts/audit-units.mjs`.

</details>

<details>
<summary><b>Render: un renderer, dos cámaras, cero tiles</b></summary>

<br>

- Cada línea es una cinta (triangle strip) extruida sobre una curva Catmull-Rom
  centrípeta que pasa por sus estaciones, proyectadas a un plano local en metros
  centrado en Santiago. Estaciones y trenes son `InstancedMesh`: un draw call cada uno.
- **3D**: cámara en perspectiva con órbita amortiguada, vista tipo maqueta inclinada.
- **2D**: ortográfica cenital con pan/zoom.
- **El switch** es una timeline GSAP de ~1,2 s que eleva y endereza la cámara mientras
  reduce el FOV manteniendo constante la altura visible — un dolly-zoom. La perspectiva
  converge así a la proyección ortográfica, y el intercambio de cámara al final es
  imperceptible.
- El contexto urbano (río Mapocho, grilla de calles) es geometría propia, no imágenes.
- El túnel procedural existe **solo** en la vista de cabina: anillos y luces se
  reposicionan en una ventana móvil alrededor de la cámara (object pooling).

60 fps en móvil: geometría de red estática (el buffer solo se reescribe durante el
morph), `pixelRatio` limitado a 2, materiales sin iluminación, sin postprocesado y un
loop de render sin allocations.

</details>

<details>
<summary><b>El morph geografía ↔ diagrama</b></summary>

<br>

Cada estación guarda dos posiciones: la geográfica (GTFS o dataset de ejemplo) y una
esquemática (ángulos 0/45/90°, espaciado uniforme), definida a mano en
`scripts/sample-data.mjs` con *pins* — estaciones ancladas a la grilla — y *vias* —
codos del trazado. Las estaciones sin pin se reparten uniformemente entre pins por
longitud de arco.

El preprocesador muestrea **ambos** trazados con la misma parametrización (16 muestras
por tramo entre estaciones), de modo que el morph es un lerp vértice a vértice que no
desliza las estaciones. Los trenes se re-muestrean cada frame sobre ambos trazados por
longitud de arco y se mezclan con el mismo progreso, sincronizado con la cámara.

</details>

<details>
<summary><b>Operación expresa: Ruta Roja y Ruta Verde</b></summary>

<br>

En L2, L4 y L5, de lunes a viernes en punta (06:00–09:00 y 18:00–21:00), los trenes
alternan dos patrones de parada. Cada patrón se detiene solo en sus estaciones más las
comunes, y cruza las demás a velocidad de crucero sin frenar — el perfil trapezoidal se
calcula entre *paradas del patrón*, no entre estaciones.

| Línea | Estaciones | Viaje común | Ruta Roja | Ruta Verde |
|---|---|---|---|---|
| L2 | 26 | 34,9 min | 31,9 min (17 paradas) | 31,9 min (17 paradas) |
| L4 | 23 | 35,5 min | 32,8 min (15 paradas) | 32,8 min (15 paradas) |
| L5 | 30 | 42,7 min | 39,6 min (21 paradas) | 39,9 min (22 paradas) |

Los trenes que ya iban en viaje al cerrarse la ventana completan su patrón.

> [!WARNING]
> **La clasificación de estaciones es una aproximación manual.** Si el GTFS trae
> variantes de parada, el preprocesador las deriva automáticamente — pero el feed de
> DTPM no modela Roja/Verde, así que la clasificación vive en `express-config.json`
> como una aproximación escrita a mano al esquema conocido a enero de 2026. Esto cambia
> con los años: contrastar con [metro.cl](https://www.metro.cl) antes de confiar en ella.

</details>

<details>
<summary><b>Horario y flota</b></summary>

<br>

El servicio corre 06:00–23:00 de lunes a sábado y 07:30–23:00 los domingos; fuera de
ese horario la app muestra la pantalla "Metro cerrado". Los trenes virtuales parten de
cada terminal según la frecuencia vigente y pausan ~20 s por andén.

| Línea | Estaciones | Frecuencia punta | Valle | Trenes @ 08:00 | Viaje completo |
|---|---|---|---|---|---|
| L1 | 27 | 120 s | 210 s | 32 | 31,9 min |
| L2 | 26 | 160 s | 260 s | 24 | 34,9 min |
| L3 | 21 | 180 s | 300 s | 22 | 32,4 min |
| L4 | 23 | 180 s | 300 s | 22 | 35,5 min |
| L4A | 6 | 300 s | 480 s | 6 | 11,7 min |
| L5 | 30 | 150 s | 240 s | 32 | 42,7 min |
| L6 | 10 | 240 s | 360 s | 10 | 20,3 min |

Flota en toda la red: **146 trenes en el pico de las 07:40**, 144 a las 08:00, 110 al
mediodía y 82 a las 22:00. En domingo o feriado son 68 al mediodía — ver
[el tipo de día no es el día de la semana](#el-tipo-de-día-no-es-el-día-de-la-semana).

</details>

<details>
<summary><b>Hacer perceptible el movimiento</b></summary>

<br>

A velocidad real, un tren a 50 km/h sobre una ciudad de 30 km es casi imperceptible.
Eso es escala, no un bug. Para que la red se sienta viva:

- **Estelas** — cada tren arrastra quads aditivos del color de su línea, que se
  desvanecen con la distancia y se apagan al detenerse.
- **Respiración** — los trenes pulsan sutilmente mientras esperan en el andén.
- **Control de tiempo** — ×1 / ×10 / ×60, slider de hora del día y un botón "● VIVO"
  que vuelve a la hora real de Santiago. En ×60 la red completa se ve circular.

Todo respeta `prefers-reduced-motion`: sin estelas, sin pulso, tweens de cámara
acortados y marquesina LED estática.

</details>

<details>
<summary><b>Decisiones de diseño</b></summary>

<br>

- **Colores de línea** aproximados a ojo contra el plano oficial: L1 `#E2231A`,
  L2 `#FFCB05`, L3 `#9A6229`, L4 `#2B3990`, L4A `#00A9E0`, L5 `#009E49`, L6 `#8F3F97`.
- **Tipografía** de señalética: [Hind](https://fonts.google.com/specimen/Hind) (sans
  humanista tipo Frutiger) más VT323 para el panel LED, con fallbacks del sistema.
- **Insignias de línea** — círculo del color con el número en blanco, como en la
  señalética real; sirven además de filtro clickeable.
- **Tooltip de estación** = placa de andén: nombre más insignias de combinación, con el
  borde del color de la línea principal.
- **Isotipo propio.** El logo oficial de Metro es marca registrada y no se usa; el rombo
  rojo es original.

</details>

## Por qué no hay datos en vivo del metro

> [!TIP]
> Esta sección habla de **trenes**. Con los buses la historia es otra — RED sí publica
> llegadas en vivo, y metrovivo las muestra. Ver [Buses](#buses).

Una versión anterior decía mostrar el estado **real** del servicio — líneas suspendidas,
estaciones cerradas — a través de un proxy serverless. Esa funcionalidad se eliminó, y
la razón vale la pena dejarla escrita.

Existen dos fuentes. Ninguna sirve desde un sitio estático:

| Fuente | Estado | Por qué falla |
|---|---|---|
| `metro.cl/api/estadoRedDetalle.php` | **Viva y correcta** | No envía cabeceras CORS. El navegador no puede leerla; necesita un proxy server-side. |
| `api.xor.cl/red/metro-network` | **Rota en silencio** | Envía `access-control-allow-origin: *`, pero scrapea `metro.cl/tu-viaje/estado-red`, una página que hoy devuelve **404**. Responde `{"issues": false, "lines": []}` para siempre. |

La segunda es la peligrosa. Devuelve HTTP 200, JSON válido y `api_status: "OK"` mientras
informa una red vacía. Contrastado con la realidad el 2026-07-30: metro.cl reportaba L5
con *"Santa Isabel estará cerrada y sin detención de trenes"*; la API comunitaria
reportaba cero incidencias.

**Un "todo normal" silenciosamente falso es peor que no tener dato**, sobre todo para
alguien decidiendo si tomar el metro. Así que la capa en vivo se fue, en vez de quedarse
equivocada.

Lo que sí sobrevivió es la parte realmente interesante: el **motor de contingencias**.
Los escenarios de [`src/scenarios.js`](src/scenarios.js) se inyectan con
`?estado=<nombre>` y la simulación reacciona de verdad: una línea suspendida deja de
despachar y los trenes en viaje frenan en su próxima estación; un tramo cerrado parte la
línea en sub-líneas que hacen turnback en las fronteras; una estación suelta cerrada se
cruza a velocidad de crucero, reusando la física de paso directo de la ruta expresa.

**Reactivar el estado en vivo** requiere exactamente una cosa: un proxy server-side para
metro.cl (sirve cualquier runtime) y un normalizador para su esquema real, que es
`{"l1": {estado, mensaje_app, estaciones: [...]}, ...}` — un objeto indexado por línea,
no el arreglo `{lineas: [...]}` que esperaba el parser antiguo. `Simulation.applyEstado()`
ya acepta la forma normalizada, así que nada más cambiaría.

## Buses

Aprieta **BUSES** y la ciudad cambia de capa: las cintas del metro desaparecen (los
discos de estación quedan como referencia urbana) y aparece **toda la flota de RED**
sobre la red oficial de recorridos. Dos fuentes, un interruptor:

- **ITINERARIO** (por defecto) — 3.579 buses ámbar al mediodía y 5.708 en la punta de
  las 08:00, en **movimiento continuo**, cada
  uno una función determinista de la hora oficial: salidas desde las ventanas de
  intervalo de `frequencies.txt`, posición interpolada entre las horas de paso por
  paradero de `stop_times.txt`. El perfil de velocidad entre paraderos sale del propio
  itinerario — el bus simulado mediano va a ~18 km/h, la velocidad comercial real. Es
  la misma clase de dato que los trenes de metrovivo: dónde DEBERÍA estar cada bus.
- **GPS** — ~5.000 buses cian como **posiciones medidas**, una petición de ~100 KB por
  minuto. Cada bus lleva su propia hora de medición y esa edad se dibuja en vez de
  taparse: lo fresco brilla cian, lo de hace cinco minutos se apaga a gris. Nada se
  anima entre mediciones — un salto honesto vale más que un deslizar inventado.

Los dos estratos jamás comparten color: **ámbar = simulado, cian = medido**, y la
tarjeta de cualquier bus dice cuál es (los simulados no tienen patente — no hay
vehículo).

**Toca un bus simulado y viajas dentro**, el mismo gesto de un clic que te mete a la
cabina de un tren. La maqueta (marcadores de 34 m, la red flotando arriba) se apaga y
se levanta una calle a escala real: calzada, soleras, eje segmentado cada 12 m y
luminarias cada 30 m — a los ~19 km/h de velocidad comercial real de RED, ese flujo
óptico es lo que hace legible la velocidad. Cada paradero del recorrido lleva su
**nombre oficial del GTFS** en el letrero, y el HUD cuenta hacia el siguiente. El destino
sale del **letrero del viaje** (`trip_headsign`): el bus dice «a Peñalolen», que es lo
que lleva puesto, y no «Avenida Lo Blanco / esq. J. Edwards Bello», que es sólo la
esquina donde termina. Los 112 recorridos circulares del feed se marcan como tales. Los
otros buses pasan a tamaño real (12 m). Viajar sólo se ofrece en el estrato
ITINERARIO: un bus medido por GPS es una foto de hace ~33 s, y meterse dentro
exigiría inventar el movimiento entre medición y medición — justo lo que el resto del
proyecto se niega a hacer. Con Escape, o el botón de salida, vuelves volando a la
órbita.

Al tocar un paradero aparecen **llegadas reales**: patente, metros de distancia y
ventana de llegada, tal como las entrega RED. Eliges un bus y se dibuja sobre su
recorrido oficial, y metrovivo lo sigue — cuando deja de verse desde ese paradero, le
pregunta al *siguiente paradero del recorrido* por la misma patente y el viaje continúa.
Cada tramo queda confirmado por una medición, no por un reloj.

Es la única capa de metrovivo con datos que **no** son simulados, así que conviene ser
exacto sobre qué está medido y qué está inferido.

**Dos fuentes, dos regímenes.**

- *Flota* — `velocidades.seguimos.cl` entrega el AVL de la flota completa (posición GPS,
  patente y timestamp POR BUS) con CORS abierto en una sola respuesta de ~100 KB
  (brotli). Medido: cada bus reporta más o menos cada minuto (el 73 % de los timestamps
  se renueva entre fotos a 70 s), así que metrovivo sondea **una vez por minuto**, solo
  con el modo encendido y la pestaña visible. Es un feed comunitario sin términos
  publicados ni garantía de continuidad — si muere, el modo flota lo dice y nada más
  depende de él.
- *Llegadas por paradero* — `https://api.xor.cl/red/bus-stop/{código}` envía
  `access-control-allow-origin: *`, o sea que un sitio estático puede leerla sin proxy.
  Solo responde si ya conoces el código del paradero y no publica ningún listado — el
  catálogo sale del GTFS, cuyo **`stop_id` *es* ese código**. Medido sobre el catálogo
  completo: el 97 % responde `status_code 0`. Un barrido de la ciudad con esta API sería
  abusivo (es el proyecto de una persona) y además mentira: entrega solo los ~2 buses
  siguientes por paradero — una *muestra* disfrazada de flota. Para eso existe el feed
  de flota.

**Qué es `meters_distance`.** Distancia al paradero **sobre el recorrido**, no en línea
recta. Verificado siguiendo 67 patentes durante 12 minutos: todas decrecen de forma
monótona, a 6–25 km/h — la velocidad comercial de un bus urbano. El backend refresca cada
**33 s** (mediana; p90 34 s).

**Qué es real y qué no:**

| | |
|---|---|
| Patente, metros, ventana de llegada | **Medido.** Viene de RED y se muestra tal cual. |
| El recorrido dibujado | **Oficial.** Geometría del DTPM. Contrastado con posiciones GPS reales: caen sobre el recorrido atribuido con **mediana de 3 m**, 72 de 73 bajo 60 m. El sentido se deduce del par (paradero, servicio), único en el 99,5 % de los casos. |
| La posición del bus sobre ese recorrido | **Inferida, y es el eslabón débil.** Es `arco(paradero) − metros`. Contra GPS real le gana a la hipótesis nula (el bus está en el paradero) en el 85 % de los casos — mediana de 653 m de error contra 3.874 m — y queda *por delante* del GPS en el 93 %, que es el signo correcto porque el dato de la API es más fresco que el AVL. Pero la referencia misma tiene 121 s de retraso mediano, así que **la posición no se puede validar mejor que a varios cientos de metros.** |

Esa última fila es la razón de que **el bus se dibuje más borroso que el tren simulado**,
al revés de lo que uno esperaría. El tren es una ficción matemática limpia y por eso lleva
una cápsula nítida. El bus es una medición sucia y lleva una mancha: una banda de
incertidumbre sobre el recorrido que cubre lo que pudo avanzar desde que se midió, crece
sola entre lecturas y *salta* cuando llega una nueva. El salto es honesto: no sabemos por
dónde pasó, sabemos dónde estaba y dónde está.

`src/bus/placement.js` es una función pura y **se abstiene** en vez de adivinar: servicio
desconocido (`413c` está vivo en la API y no existe en `routes.txt`), paradero que sirve
los dos sentidos, bus antes del inicio de la variante que tenemos, o dos paraderos que
discrepan más de 250 m sobre dónde está. Ninguna de esas ramas se rellena por si acaso:
un punto plausible y equivocado es peor que ningún punto.

**La política de tasa vive en el transporte, no en quien llama.** `src/bus/xor-client.js`
es el único archivo del proyecto autorizado a llamar `fetch`. api.xor.cl es el proyecto
GPL-3.0 de una persona y cada petición nuestra golpea a red.cl/SMSBus por detrás; un sitio
estático no tiene caché compartida, así que N visitantes son N× el tráfico. Cubo de
fichas, piso de 20 s por paradero, tope duro de sesión, circuit breaker y **cero peticiones
con la pestaña oculta**. El sondeo es bajo demanda — el paradero abierto, más uno por
delante mientras sigues un bus. Nunca un barrido de la ciudad, que además sería mentira:
la API entrega solo los ~2 buses siguientes por paradero, o sea que ese mapa sería una
*muestra* presentada como flota.

**Las patentes** solo aparecen en el bus que eliges seguir. Va pintada en el exterior del
bus y es lo que vuelve *verificable* el seguimiento — puedes mirar el bus y comprobar que
metrovivo no miente. Pero patente + posición + hora sostenidas en el tiempo describen la
jornada de una persona identificable por quien conoce el turno, así que: nunca en listas,
nunca en `localStorage`, nunca en la URL, y **ninguna métrica de puntualidad, velocidad o
conducción derivada de estos datos**. Ese es el uso que lo convierte en vigilancia laboral
con estética de dataviz.

La capa está tras una puerta dura `data.meta.source !== 'sample'`: paraderos de precisión
métrica sobre estaciones aproximadas se desalinean de un modo que el visitante no puede
diagnosticar.

## Datos

Todo se genera desde el **GTFS oficial del DTPM**:

```bash
npm run gtfs          # descubre y descarga el feed vigente
npm run data .cache/gtfs/<version>       # -> data/network.json  (metro)
npm run data:bus .cache/gtfs/<version>   # -> data/bus/*.json    (buses)
```

`scripts/fetch-gtfs.mjs` busca el `.zip` fechado vigente en
`dtpm.cl/index.php/noticias/gtfs-vigente`, lo descomprime (sin dependencias npm: lee el
ZIP con `zlib`) y anota la procedencia en `data/.gtfs-provenance.json`. Tiene dos guardias
que no son opcionales, porque el modo de fallo de este dominio no es el 404 sino el 200
con datos podridos:

1. **Rechaza `dtpm.cl/descargas/gtfs/GTFS.zip`** (el sin fecha). Esa URL responde 200 con
   6 MB de GTFS perfectamente bien formado cuyo `feed_end_date` fue **20201231**. Es la
   que siguen publicando Mobility Database y casi todos los tutoriales.
2. **Aborta si `feed_end_date` ya pasó.** Un feed vencido sigue pareciendo válido y
   contiene en silencio paraderos que ya no existen.

`data/network.json` (110 KB) guarda las curvas muestreadas, ambas posiciones por
estación, el `lon/lat` de origen de cada una, frecuencias por franja y tipo de día, el
calendario del feed y el interior de cada estación. `data/bus/` guarda el catálogo de
paraderos y la geometría de recorridos — ver [Buses](#buses).

### El tipo de día no es el día de la semana

`calendar_dates.txt` declara los ocho feriados del feed, y en todos ellos la red opera con
**horario de domingo**. El 18 de septiembre de 2026 cae viernes: sin esa tabla, metrovivo
dibujaba **110 trenes y 3.579 buses** sobre una ciudad que ese día mueve **68 trenes y
2.430 buses**. El reloj consulta la tabla antes de decidir el tipo de día, y cuando hay
feriado la interfaz lo dice — si no, un viernes con frecuencia de domingo parece una
falla del simulador.

`feed_info.txt` aporta la otra mitad: hasta cuándo valen estos horarios. `fetch-gtfs.mjs`
ya se niega a descargar un feed vencido, pero eso no protege a un sitio ya publicado, cuyos
datos envejecen solos. Ahora la ventana de validez viaja dentro de `network.json` y la
página avisa cuando la fecha de hoy queda fuera. Un feed vencido no falla: sigue
produciendo trenes perfectamente creíbles.

### La estación por dentro

`pathways.txt` es el grafo caminable de cada estación — 7.388 tramos con su tiempo de
recorrido declarado — y `levels.txt` sus niveles. Con ellos, **cuánto se tarda en
combinar** deja de ser una suposición: es la suma de los `traversal_time` del camino más
corto entre los andenes de una línea y los de la otra. Las 17 combinaciones de la red
están medidas, de los **22 s de Los Héroes** (L1↔L2) a los **2:41 de Plaza de Armas**
(L3↔L5, con L3 cuatro niveles bajo la calle).

El puente entre ambas cosas no es obvio y vale la pena anotarlo: los andenes que usan los
`stop_times` (`LH_L1_V1`) **no son nodos del grafo**; los nodos son zonas y equipos
(`LH:ZP_04`, `LH:ESC01_BOT`). La unión la hace el propio GTFS — las **zonas de embarque**
(`location_type=4`) cuelgan del andén como `parent_station` y sí son nodos. Sin esa cadena
hay que inventarse una arista; aquí no se inventa ninguna, porque los 286 andenes de metro
tienen zona de embarque.

**La red deja de ser plana.** `levels.txt` da el nivel de cada andén, así que las líneas
ahora suben y bajan con él: el viaducto de L5 se eleva sobre la ciudad y L3 se hunde bajo
Plaza de Armas. Lo medido es el **orden** de niveles, no los metros — intenté derivar la
profundidad real sumando `stair_count × huella` por la cadena de escaleras y no se puede:
las transiciones de las estaciones profundas van servidas sólo por mecánicas y ascensores,
que no declaran peldaños, así que la cadena se corta justo donde importaría. La altura que
se dibuja es orden de nivel × una constante, con el mismo criterio con que una cinta de
110 m de ancho representa 6 m de vía. La constante sí es medida — 4,2 m es la mediana de
291 saltos de un nivel con peldaños contados — pero va multiplicada ×26 para que cinco
plantas se lean en una red de 20 km. Dentro de la cabina esa exageración se retira y se
usan los metros de verdad: a ×26 el túnel bajaría al 11 % sostenido y ningún metro pasa
del 4 %.

De paso, el feed corrige dos cosas que uno da por sentadas: **Metro de Santiago no es todo
subterráneo** (19 andenes van en viaducto — hasta el nivel +3 en L5 poniente — y 5 están
a nivel de calle), y **la accesibilidad no es una etiqueta binaria**: las 126 estaciones
tienen ascensor y 283 de 286 andenes se declaran accesibles, pero sólo **166 de los 298
accesos** de calle lo son. La estación puede ser practicable por una boca y no por la de
al lado, así que el panel publica las dos cifras.

<details>
<summary><b>Qué cambió de verdad al validar contra un feed de producción</b></summary>

<br>

El camino GTFS nunca se había ejecutado contra un feed real. Hacerlo destapó cuatro bugs,
todos de la misma familia — código que degradaba en silencio en vez de fallar:

| | |
|---|---|
| **Las frecuencias salían del dataset de ejemplo** | Los viajes de metro van con horario explícito en `stop_times.txt`; **ni uno solo de los 10.438 viajes de L1–L6 aparece en `frequencies.txt`**. `bandsFor()` devolvía vacío y el build caía al ejemplo — justo en la magnitud que define al proyecto — mientras se etiquetaba `meta.source: "gtfs"`. Ahora se derivan de las salidas reales. |
| **Se inventaba Ruta Expresa en L1, L3 y L6** | El heurístico tomaba la 2ª y 3ª firma de paradas más larga como Roja/Verde. Un feed real trae muchas firmas por línea y casi todas son servicios cortos: L1 tiene 6, L3 tiene 15, L6 tiene 7, y **ninguna salta una sola estación interior**. Ruta Expresa = mismos terminales + salta interiores; ahora coincide con la realidad (solo L2, L4 y L5). |
| **Las frecuencias de día hábil salían a la mitad** | El metro programa `LJ` (lun–jue) y `V` (viernes) como calendarios separados, ambos de tipo `wd`. Sumarlos dejaba L1 en 1 min de punta en vez de ~2. |
| **Seis estaciones muy céntricas se caían del diagrama** | El vocabulario de ids del proyecto es anterior al feed y abrevia (`u-de-chile` vs `universidad-de-chile`). Se estaban colocando por interpolación. |

Las coordenadas del dataset de ejemplo resultaron estar desviadas una **mediana de 636 m**
y hasta **4,1 km** (Pudahuel) — no los ±300 m que se decían. `tests/units.test.js` medía
esa desviación en vez de la proyección; ahora compara contra el `ll` de cada estación, y
el error real de la proyección es de **0,01–0,58 %**.

</details>

## Deploy

Cada push a `main` publica en GitHub Pages vía
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): primero corren los tests,
después el build, después el deploy. La única configuración es **Settings → Pages →
Source: GitHub Actions**. La ruta base se deriva del nombre del repositorio
automáticamente, así que un fork se publica en su propia URL sin editar nada.

## Contribuir

Issues y pull requests son bienvenidos. Corre `npm test` y `npm run smoke` antes de abrir
uno. Lo más útil ahora mismo: validar el build contra un feed GTFS de producción, y
verificar la clasificación de Ruta Roja/Verde de `express-config.json` contra la
información actual de metro.cl.

## Licencia

El código es [MIT](LICENSE). Marcas, procedencia de los datos y atribución están en
[NOTICE.md](NOTICE.md).

metrovivo no está afiliado a Metro de Santiago ni a la DTPM. "Metro" y su logotipo son
marcas de sus respectivos titulares; este proyecto usa un isotipo propio y colores
aproximados de la señalética. Las posiciones de los trenes son simuladas y no deben
usarse para planificar un viaje.
