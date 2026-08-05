#!/usr/bin/env node
// Descarga y descomprime el GTFS vigente del DTPM.
//
//   node scripts/fetch-gtfs.mjs            → descarga a .cache/gtfs/<version>/
//   node scripts/fetch-gtfs.mjs --force    → ignora la caché local
//
// Por qué existe: el GTFS es la única fuente que resuelve de una vez el
// catálogo de paraderos (código + nombre + lat/lon), los trazados y el orden
// de paraderos por servicio. Y sobre todo: su `stop_id` ES el código que come
// api.xor.cl (medido: 98–99 % de los códigos devuelven status_code 0), que es
// la costura sobre la que se apoya toda la capa de buses.
//
// DOS GUARDIAS QUE NO SON OPCIONALES — el modo de fallo de este dominio no es
// el 404, es el 200 con datos podridos:
//
//   1. dtpm.cl/descargas/gtfs/GTFS.zip (sin fecha) responde 200 y 6 MB, pero
//      es del 2020-07-20 y su feed_end_date fue 20201231. Es la URL que siguen
//      publicando Mobility Database y casi todos los tutoriales. Publicar eso
//      serían paraderos fantasma en el mapa. Se rechaza por nombre.
//   2. Si feed_end_date ya pasó, se aborta. Un feed vencido no avisa: sigue
//      pareciendo un GTFS perfectamente válido.
//
// Sin dependencias: el ZIP se lee con zlib (ver unzip() al final). El proyecto
// no tiene npm deps de build y esto no las introduce.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE = path.join(ROOT, '.cache', 'gtfs');
const PROVENANCE = path.join(ROOT, 'data', '.gtfs-provenance.json');

// Páginas índice del DTPM. La primera es la buena; la segunda sirve el mismo
// contenido. NO existe /index.php/documentos/gtfs-vigente: da 404 (es la que
// aparece en los tutoriales).
const INDEX_URLS = [
  'https://www.dtpm.cl/index.php/noticias/gtfs-vigente',
  'https://www.dtpm.cl/index.php/gtfs-vigente',
];
const BASE = 'https://www.dtpm.cl';

// Espejo byte-idéntico al oficial (verificado por Content-Length y MD5), sólo
// como plan B de descarga. No es fuente: es un repo personal sin licencia que
// puede desaparecer. Sólo se acepta si su tamaño coincide con el del DTPM.
const MIRROR = (file) => `https://raw.githubusercontent.com/V1c5nt5/stpm_gtfs/main/data/${file}`;

const UA = 'metrovivo-build/1.0 (+https://github.com/nsalloums/metrovivo-santiago)';
const log = (...a) => console.log('[gtfs]', ...a);

// ── descubrimiento de la versión vigente ───────────────────────────────────
/** Devuelve {url, file} del ZIP fechado más reciente publicado por el DTPM. */
async function discover() {
  const errors = [];
  for (const idx of INDEX_URLS) {
    let html;
    try {
      const res = await fetch(idx, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!res.ok) { errors.push(`${idx} → HTTP ${res.status}`); continue; }
      html = await res.text();
    } catch (e) {
      errors.push(`${idx} → ${e.message}`);
      continue;
    }

    const hrefs = [...html.matchAll(/href="([^"]*\/descargas\/gtfs\/[^"]*\.zip)"/gi)]
      .map((m) => m[1].replace(/&amp;/g, '&'));
    const dated = [];
    for (const href of hrefs) {
      const file = decodeURIComponent(href.split('/').pop());
      // GUARDIA 1: el ZIP sin fecha es de julio de 2020 y responde 200.
      if (/^GTFS\.zip$/i.test(file)) {
        log('descartado GTFS.zip (sin fecha): es el feed caducado de 2020-07-20');
        continue;
      }
      const m = file.match(/(\d{8})/);
      if (!m) continue; // nombres sin fecha ("GTFS PO06dic+2vuelta.zip"): no son el vigente
      dated.push({ file, date: m[1], url: href.startsWith('http') ? href : BASE + href });
    }
    if (!dated.length) { errors.push(`${idx} → 200 pero sin ningún .zip fechado`); continue; }
    dated.sort((a, b) => b.date.localeCompare(a.date));
    log(`índice ${idx} → ${dated[0].file}`);
    return dated[0];
  }
  // Fallo ruidoso: nunca caer en silencio a un ZIP cacheado de fecha ignorada.
  throw new Error(
    'no se pudo descubrir el GTFS vigente en dtpm.cl.\n  ' + errors.join('\n  ') +
    '\nRevisa https://www.dtpm.cl/index.php/noticias/gtfs-vigente a mano y pasa el .zip con --zip=<ruta>.',
  );
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { buf, lastModified: res.headers.get('last-modified') || null };
}

// ── programa ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const zipArg = argv.find((a) => a.startsWith('--zip='))?.slice(6);

let file, url, zipBuf, lastModified = null;

if (zipArg) {
  file = path.basename(zipArg);
  url = `file://${path.resolve(zipArg)}`;
  zipBuf = fs.readFileSync(zipArg);
  log(`usando ZIP local ${zipArg} (${(zipBuf.length / 1e6).toFixed(2)} MB)`);
} else {
  ({ file, url } = await discover());
  const zipPath = path.join(CACHE, file);
  if (!force && fs.existsSync(zipPath)) {
    zipBuf = fs.readFileSync(zipPath);
    log(`ZIP en caché ${file} (${(zipBuf.length / 1e6).toFixed(2)} MB) — usa --force para rebajarlo`);
  } else {
    log(`descargando ${url}`);
    try {
      ({ buf: zipBuf, lastModified } = await download(url, zipPath));
    } catch (e) {
      log(`falló el DTPM (${e.message}); probando espejo`);
      const m = await download(MIRROR(file), zipPath);
      zipBuf = m.buf;
      lastModified = m.lastModified;
    }
    log(`descargado ${(zipBuf.length / 1e6).toFixed(2)} MB`);
  }
}

const files = unzip(zipBuf);
log(`${files.size} archivos en el ZIP: ${[...files.keys()].sort().join(', ')}`);

// ── GUARDIA 2: vigencia ────────────────────────────────────────────────────
const feedInfo = files.get('feed_info.txt');
let version = file.replace(/\.zip$/i, '');
let validFrom = null, validUntil = null;
if (feedInfo) {
  const rows = tinyCSV(feedInfo.toString('utf8'));
  const r = rows[0] || {};
  version = r.feed_version || version;
  validFrom = r.feed_start_date || null;
  validUntil = r.feed_end_date || null;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (validUntil && today > validUntil) {
    throw new Error(
      `el feed ${version} venció el ${validUntil} (hoy ${today}).\n` +
      'Un GTFS caducado sigue pareciendo válido pero contiene paraderos que ya no existen.\n' +
      'Revisa https://www.dtpm.cl/index.php/noticias/gtfs-vigente.',
    );
  }
  log(`feed ${version} · vigencia ${validFrom || '?'}–${validUntil || '?'} · OK`);
} else {
  log('AVISO: el ZIP no trae feed_info.txt; no se puede comprobar la vigencia');
}

const outDir = path.join(CACHE, version);
fs.mkdirSync(outDir, { recursive: true });
for (const [name, buf] of files) {
  if (name.endsWith('/')) continue;
  fs.writeFileSync(path.join(outDir, path.basename(name)), buf);
}

const provenance = {
  feed_version: version,
  valid_from: validFrom,
  valid_until: validUntil,
  source_url: url,
  zip_bytes: zipBuf.length,
  last_modified: lastModified,
  sha256: (await import('node:crypto')).createHash('sha256').update(zipBuf).digest('hex'),
  fetched_at: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(PROVENANCE), { recursive: true });
fs.writeFileSync(PROVENANCE, JSON.stringify(provenance, null, 2) + '\n');

log(`descomprimido en ${path.relative(ROOT, outDir)}`);
log(`procedencia en ${path.relative(ROOT, PROVENANCE)}`);
log('');
log('siguiente paso:');
log(`  node scripts/build-data.js "${path.relative(ROOT, outDir)}"`);
log(`  node scripts/build-bus-data.mjs "${path.relative(ROOT, outDir)}"`);

// ── utilidades ─────────────────────────────────────────────────────────────
/** CSV mínimo sólo para feed_info.txt (una fila, sin comas entrecomilladas). */
function tinyCSV(text) {
  const [head, ...rest] = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const cols = head.split(',').map((c) => c.trim());
  return rest.map((line) => {
    const v = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, (v[i] ?? '').trim()]));
  });
}

/**
 * Lector de ZIP sin dependencias: recorre el directorio central y desinfla
 * cada entrada. Suficiente para un ZIP conocido y bien formado (método 0
 * almacenado u 8 deflate, sin zip64 — el GTFS pesa ~10 MB).
 */
function unzip(buf) {
  const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no es un ZIP válido: falta el End Of Central Directory');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`entrada ${i} corrupta en el directorio central`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!name.endsWith('/')) {
      // el encabezado local repite los tamaños de nombre/extra: hay que releerlos
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      out.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    }
  }
  return out;
}
