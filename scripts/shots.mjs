#!/usr/bin/env node
// Capturas para el README, sobre el build real (no mockups).
//
// Uso: npm run build && node scripts/shots.mjs
// Escribe docs/*.png. Requiere Chromium (`npx playwright install chromium`).

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = 4601;
const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));   // imágenes del README
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url)); // servidas por el sitio
mkdirSync(DOCS, { recursive: true });
mkdirSync(PUBLIC, { recursive: true });

const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const server = spawn(process.execPath,
  [viteBin, 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });

for (let i = 0; i < 40; i++) {
  try { await fetch(`http://localhost:${PORT}/`); break; }
  catch { await new Promise((r) => setTimeout(r, 250)); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

/** Abre la app en un instante dado y espera a que la escena esté poblada. */
async function open(query, { width = 1600, height = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`http://localhost:${PORT}/${query}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metrovivo?.sim?.trains?.length > 0, { timeout: 20000 });
  await page.waitForTimeout(1500); // estelas y fades asentados
  return page;
}

const shot = async (page, name) => {
  await page.screenshot({ path: `${DOCS}${name}.png` });
  console.log(`✓ docs/${name}.png`);
};

// 1. Vista orbital 3D en hora punta — la imagen principal
const p1 = await open('?t=08:15&day=wd');
await shot(p1, 'hero-3d');

// 2. Plano esquemático 2D (morph completo)
const p2 = await open('?t=08:15&day=wd');
await p2.click('#mode-toggle');
await p2.waitForFunction(() => window.metrovivo.view.mode === '2d' && !window.metrovivo.view.transitioning,
  { timeout: 15000 });
await p2.waitForTimeout(1200);
await shot(p2, 'diagrama-2d');

// 3. Vista de conductor
const p3 = await open('?t=08:15&day=wd');
// mismo picking que el smoke: proyectar un tren en movimiento a pantalla
const target = await p3.evaluate(() => {
  const mv = window.metrovivo;
  const cam = mv.view.camera;
  for (const t of mv.sim.trains) {
    if (!t.moving) continue;
    const p = new (Object.getPrototypeOf(mv.view.persp.position).constructor)();
    mv.network.pointAt(t.lineId, t.sGeo, t.sSchem, p, null);
    p.project(cam);
    const x = (p.x * 0.5 + 0.5) * innerWidth, y = (-p.y * 0.5 + 0.5) * innerHeight;
    if (p.z < 1 && x > 60 && x < innerWidth - 60 && y > 100 && y < innerHeight - 160) return { x, y };
  }
  return null;
});
if (target) {
  await p3.mouse.click(target.x, target.y);
} else {
  await p3.evaluate(() => {
    const mv = window.metrovivo;
    mv.enterCab(mv.sim.trains.find((x) => x.moving) || mv.sim.trains[0]);
  });
}
await p3.waitForTimeout(3200); // vuelo de cámara + fade del contexto
const inCab = await p3.evaluate(() => window.metrovivo.cab.active);
if (inCab) await shot(p3, 'cabina');
else console.log('✗ no se pudo entrar a cabina');

// 4. Escenario de contingencia: L1 suspendida en gris
const p4 = await open('?t=08:15&day=wd&estado=l1-suspendida');
await shot(p4, 'escenario-suspension');

// 5. Panel LED de próximos trenes
const p5 = await open('?t=08:15&day=wd');
await p5.selectOption('#station-select', 'baquedano');
await p5.waitForTimeout(1600);
await shot(p5, 'panel-led');

// 6. Social preview / og:image — 1280×640 es el tamaño que pide GitHub.
// Va a public/ para que el sitio la sirva en una URL absoluta estable
// (los crawlers de OG no resuelven rutas relativas).
const p6 = await open('?t=08:15&day=wd', { width: 1280, height: 640 });
await p6.screenshot({ path: `${PUBLIC}og.png` });
console.log('✓ public/og.png');

await browser.close();
server.kill();
console.log('\nlisto');
