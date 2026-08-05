#!/usr/bin/env node
// Smoke test headless de metrovivo sobre el build local.
//
// Uso: npm run build && npm run smoke
// Requiere Playwright (devDependency) y un Chromium: `npx playwright install
// chromium`, o define PW_EXECUTABLE apuntando a un binario existente.
//
// Verifica: consola sin errores, canvas renderizando (no todo negro),
// contador de trenes > 0, click sobre un tren entra a la cabina, y "Salir"
// restaura la órbita y el toggle 2D/3D.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = 4599;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── chromium: PW_EXECUTABLE → binario de sandbox → instalación estándar ──
function findExecutable() {
  if (process.env.PW_EXECUTABLE && existsSync(process.env.PW_EXECUTABLE)) return process.env.PW_EXECUTABLE;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (existsSync(base)) {
    for (const d of readdirSync(base)) {
      if (d.startsWith('chromium_headless_shell')) {
        const p = `${base}/${d}/chrome-linux/headless_shell`;
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined; // instalación estándar de playwright
}

// ── servidor de preview sobre dist/ ──
// se invoca el binario de vite directamente (en Windows `npx` es un .cmd y
// spawn() sin shell falla con ENOENT)
const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const server = spawn(process.execPath,
  [viteBin, 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore', detached: false,
  });
const url = `http://localhost:${PORT}/?t=12:00&day=wd`;
for (let i = 0; i < 40; i++) {
  try { await fetch(`http://localhost:${PORT}/`); break; }
  catch { await new Promise((r) => setTimeout(r, 250)); }
}

let failed = 0;
try {
  const browser = await chromium.launch({
    executablePath: findExecutable(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // 1. consola limpia (se toleran fuentes externas bloqueadas por red)
  const realErrors = errors.filter((e) => !/ERR_CONNECTION|net::|fonts\.g/i.test(e));
  check('consola sin errores', realErrors.length === 0, realErrors.join(' | ').slice(0, 300));

  // 2. el canvas renderiza (no todo negro): screenshot → conteo de píxeles
  const shot = (await page.screenshot({ clip: { x: 100, y: 120, width: 700, height: 450 } })).toString('base64');
  const lit = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
    return n / (d.length / 4);
  }, shot);
  check('canvas renderiza (píxeles encendidos)', lit > 0.01, `${(lit * 100).toFixed(1)}% del área`);

  // 3. simulación viva a las 12:00
  const count = await page.evaluate(() => window.metrovivo.sim.trains.length);
  check('contador de trenes > 0 a las 12:00', count > 0, `${count} trenes`);

  // 4. click REAL sobre un tren → cabina
  const target = await page.evaluate(() => {
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
  check('hay un tren clickeable en pantalla', Boolean(target));
  if (target) {
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(2200);
    const inCab = await page.evaluate(() => window.metrovivo.cab.active);
    check('click en tren entra a cabina', inCab);
    const hud = await page.textContent('#cab-hud');
    check('HUD de cabina con contenido', /Próxima estación|Deteniéndose/.test(hud || ''));

    // 5. Salir restaura órbita y el toggle 2D/3D vuelve a operar
    await page.click('#cab-exit');
    await page.waitForTimeout(2000);
    const after = await page.evaluate(() => ({
      cab: window.metrovivo.cab.active,
      orbit: window.metrovivo.view.controls3d.enabled,
    }));
    check('Salir restaura la órbita', !after.cab && after.orbit);
    await page.click('#mode-toggle');
    await page.waitForTimeout(1800);
    const mode = await page.evaluate(() => window.metrovivo.view.mode);
    check('toggle 2D operativo tras salir de cabina', mode === '2d');
  }

  // ── escenario de contingencia: "L1 suspendida" ──
  const p2 = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors2 = [];
  p2.on('pageerror', (e) => errors2.push(String(e)));
  p2.on('console', (m) => { if (m.type() === 'error') errors2.push(m.text()); });
  await p2.goto(`http://localhost:${PORT}/?estado=l1-suspendida&t=12:00&day=wd`, { waitUntil: 'networkidle' });
  // esperar a que la simulación arranque con el escenario aplicado (headless lento)
  await p2.waitForFunction(
    () => window.metrovivo?.scenario && window.metrovivo.sim.trains.length > 0,
    { timeout: 20000 },
  ).catch(() => {});
  await p2.waitForTimeout(400);
  const est = await p2.evaluate(() => {
    const mv = window.metrovivo;
    const chip = document.getElementById('estado-chip');
    return {
      l1: mv.sim.trains.filter((t) => t.lineId === 'L1').length,
      otras: mv.sim.trains.filter((t) => t.lineId !== 'L1').length,
      gris: mv.network.lines.get('L1').mesh.material.color.getHex() === 0x5a5a64,
      chip: chip.className,
      chipVisible: !chip.hidden,
      chipTxt: chip.querySelector('.txt').textContent,
      banner: !document.getElementById('contingencia').hidden,
    };
  });
  const realErr2 = errors2.filter((e) => !/ERR_CONNECTION|net::|fonts\.g/i.test(e));
  check('escenario L1 suspendida: consola sin errores', realErr2.length === 0, realErr2.join(' | ').slice(0, 200));
  check('L1 suspendida: contador de L1 en 0', est.l1 === 0, `${est.l1} trenes L1, ${est.otras} en otras líneas`);
  check('L1 suspendida: línea atenuada en gris', est.gris);
  check('L1 suspendida: chip visible + banner de contingencia',
    est.chipVisible && est.chip === 'estado-alerts' && est.banner, `${est.chip} / ${est.chipTxt}`);
  // el chip debe rotularse como SIMULADO: nunca afirmar estado real
  check('el chip declara que el escenario es simulado', /simulado/i.test(est.chipTxt || ''), est.chipTxt);

  // ── sin escenario: la app no hace ninguna petición de red propia ──
  const p3 = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const reqs = [];
  p3.on('request', (r) => { if (!/fonts\.(googleapis|gstatic)/.test(r.url())) reqs.push(r.url()); });
  const errors3 = [];
  p3.on('pageerror', (e) => errors3.push(String(e)));
  p3.on('console', (m) => { if (m.type() === 'error') errors3.push(m.text()); });
  await p3.goto(`http://localhost:${PORT}/?t=12:00&day=wd`, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(600);
  const sinEstado = await p3.evaluate(() => ({
    scenario: window.metrovivo.scenario,
    chipVisible: !document.getElementById('estado-chip').hidden,
    trains: window.metrovivo.sim.trains.length,
  }));
  // Invariante real: al CARGAR, la página no habla con nadie salvo las fuentes.
  // El filtro anterior buscaba la subcadena "/api/", que "https://api.xor.cl/
  // red/bus-stop/PA1" esquiva (es "//api." seguido de "/red/"): el check habría
  // quedado en verde justo cuando dejara de ser cierto. Se mira el HOST.
  const propio = (u) => {
    try {
      const h = new URL(u).hostname;
      return h === 'localhost' || h === '127.0.0.1' || /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(h);
    } catch { return true; } // data:, blob:, about:
  };
  const apiReqs = reqs.filter((u) => !propio(u));
  const realErr3 = errors3.filter((e) => !/ERR_CONNECTION|net::|fonts\.g/i.test(e));
  check('sin escenario: consola sin errores', realErr3.length === 0, realErr3.join(' | ').slice(0, 200));
  check('sin escenario: no hay chip de estado', sinEstado.scenario === null && !sinEstado.chipVisible);
  check('sin escenario: la simulación corre igual', sinEstado.trains > 0, `${sinEstado.trains} trenes`);
  // el sitio es 100% estático: al cargar no se consulta ningún servicio ajeno
  check('cero peticiones a terceros al cargar (sitio estático)', apiReqs.length === 0, apiReqs.join(' | '));

  await browser.close();
} catch (e) {
  check('ejecución del smoke test', false, String(e).slice(0, 300));
} finally {
  server.kill();
}

failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks OK`);
process.exit(failed ? 1 : 0);
