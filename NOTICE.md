# Marcas, datos y atribución

metrovivo **no está afiliado** a Metro de Santiago S.A. ni a la Dirección de
Transporte Público Metropolitano (DTPM).

- **Marcas.** "Metro", "Metro de Santiago", "Ruta Roja" y "Ruta Verde" son marcas de
  sus respectivos titulares. El logotipo oficial de Metro es marca registrada y **no
  se usa** en este proyecto: el isotipo (rombo rojo con el centro vaciado) es
  original. Los colores de línea son aproximaciones ajustadas a ojo contra el plano
  público, no valores oficiales de marca.

- **Datos de la red.** Provienen del GTFS público publicado por DTPM en
  [dtpm.cl](https://www.dtpm.cl/index.php/documentos/gtfs-vigente), o del dataset de
  ejemplo incluido en `scripts/sample-data.mjs` cuando no se entrega un feed. Las
  coordenadas del dataset de ejemplo son aproximadas (±300 m).

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
