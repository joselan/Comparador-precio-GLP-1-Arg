/**
 * Backfill histórico de precios desde la Wayback Machine (web.archive.org).
 *
 * El historial de la app sólo tiene datos desde que se activó el scraper. Este
 * script reconstruye hasta ~1 año de precios (aprox. semanales) leyendo
 * snapshots archivados de las páginas de producto de alfabeta.net en la Wayback
 * Machine, los parsea con el MISMO parser del scraper (parsePricesFromHtml) y los
 * guarda en la colección priceHistory (un documento por fecha, id = YYYY-MM-DD).
 *
 * Uso:
 *   node backfill-history.js --dry-run   # sondeo: muestra qué encontraría, sin escribir
 *   node backfill-history.js             # escribe en Firebase (requiere credenciales)
 *
 * Variables/flags:
 *   --dry-run            no escribe en Firebase ni requiere credenciales
 *   WEEKS=52             cuántas semanas hacia atrás intentar (default 52)
 *   BACKFILL_OVERWRITE   si "1", pisa puntos existentes; por defecto no toca fechas ya cargadas
 *
 * Corre en GitHub Actions (workflow_dispatch): desde ahí hay salida a
 * alfabeta.net y web.archive.org y están las credenciales de Firebase. Desde el
 * entorno de desarrollo esos hosts están bloqueados por la política de red.
 */

const { parsePricesFromHtml, buildSnapshot, MEDICATIONS } = require('./update-prices.js');

const DRY_RUN = process.argv.includes('--dry-run');
const WEEKS = parseInt(process.env.WEEKS || '52', 10);
const OVERWRITE = process.env.BACKFILL_OVERWRITE === '1';
const FIREBASE_PROJECT_ID = 'comparador-precios-glp-1-arg';
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const yyyymmdd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
const isoDate = (d) => d.toISOString().split('T')[0];

// --- Firebase (lazy; sólo si NO es dry-run) ---
let admin = null, db = null;
function initFirebase() {
  admin = require('firebase-admin');
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
}

// --- Descubrir la URL actual de la página de producto en alfabeta (vía búsqueda) ---
async function discoverProductUrl(browser, searchTerm) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-AR,es;q=0.9,en;q=0.7' });
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('https://www.alfabeta.net/precio/buscar.html', { waitUntil: 'networkidle2', timeout: 30000 });

    const inputSel = 'input[name="str"], input[type="search"], input[type="text"]';
    await page.waitForSelector(inputSel, { timeout: 5000 });
    await page.focus(inputSel);
    await page.keyboard.type(searchTerm);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.keyboard.press('Enter'),
    ]);

    let link = await page.$('.resultsearch a, .rprod a, a.rprod');
    if (!link) link = await page.$('.rprod');
    if (!link) return null;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      link.click(),
    ]);
    return page.url();
  } catch (e) {
    console.log(`    ⚠ discovery error: ${e.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// --- Wayback CDX genérico ---
async function cdxQuery(params) {
  const q = new URLSearchParams(params);
  const api = `https://web.archive.org/cdx/search/cdx?${q.toString()}`;
  const res = await fetch(api, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`CDX ${res.status}`);
  const rows = await res.json();
  return (Array.isArray(rows) && rows.length > 1) ? rows.slice(1) : []; // rows[0] = header
}

const rowsToSnaps = (rows) => rows.map(r => ({
  ts: r[0], original: r[1],
  date: new Date(`${r[0].slice(0,4)}-${r[0].slice(4,6)}-${r[0].slice(6,8)}T12:00:00Z`),
}));

// Cuántas capturas EXISTEN de esta URL en toda la historia de Wayback (diagnóstico).
async function waybackAllTimeCount(url) {
  const noProto = url.replace(/^https?:\/\//, '').split('#')[0];
  const noWww = noProto.replace(/^www\./, '');
  try {
    const rows = await cdxQuery({ url: noWww, matchType: 'prefix', output: 'json', fl: 'timestamp', limit: '20000' });
    return rows.length;
  } catch (e) { return `err:${e.message}`; }
}

// --- Snapshots (uno por día) de una URL en el rango, probando variantes ---
async function waybackSnapshots(url, fromDate, toDate) {
  const noProto = url.replace(/^https?:\/\//, '').split('#')[0];
  const noWww = noProto.replace(/^www\./, '');
  const common = {
    from: yyyymmdd(fromDate), to: yyyymmdd(toDate), output: 'json',
    fl: 'timestamp,original,statuscode', filter: 'statuscode:200',
    collapse: 'timestamp:8', limit: '1000',
  };
  // Exacta con/sin www, y prefijo sin www (por si cambió el query/URL).
  const variants = [
    { url: noProto, matchType: 'exact' },
    { url: noWww,   matchType: 'exact' },
    { url: noWww,   matchType: 'prefix' },
  ];
  const seen = new Map();
  for (const v of variants) {
    try {
      const rows = await cdxQuery({ ...common, ...v });
      console.log(`    cdx ${v.matchType.padEnd(6)} ${v.url} → ${rows.length}`);
      for (const s of rowsToSnaps(rows)) if (!seen.has(s.ts)) seen.set(s.ts, s);
    } catch (e) { console.log(`    cdx error (${v.matchType} ${v.url}): ${e.message}`); }
    await sleep(300);
  }
  return [...seen.values()].sort((a, b) => a.date - b.date);
}

// De todos los snapshots disponibles, elegir ~1 por semana (el más cercano a
// cada objetivo semanal, dentro de ±4 días) para no bajar de más.
function pickWeekly(snapshots, fromDate, toDate, weeks) {
  const chosen = [];
  const usedTs = new Set();
  for (let w = 0; w <= weeks; w++) {
    const target = new Date(toDate.getTime() - w * 7 * 86400000);
    let best = null, bestDiff = Infinity;
    for (const s of snapshots) {
      const diff = Math.abs(s.date - target);
      if (diff < bestDiff) { bestDiff = diff; best = s; }
    }
    if (best && bestDiff <= 4 * 86400000 && !usedTs.has(best.ts)) {
      usedTs.add(best.ts);
      chosen.push(best);
    }
  }
  return chosen.sort((a, b) => a.date - b.date);
}

async function fetchArchivedHtml(snap) {
  // El sufijo id_ devuelve el HTML original archivado, sin el banner de Wayback.
  const url = `https://web.archive.org/web/${snap.ts}id_/${snap.original}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`archive ${res.status}`);
  return res.text();
}

async function main() {
  console.log(`\n[${new Date().toISOString()}] Backfill de historial${DRY_RUN ? ' — DRY RUN (sin escribir)' : ''}`);
  console.log(`Semanas hacia atrás: ${WEEKS} · Overwrite: ${OVERWRITE ? 'sí' : 'no'}`);

  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - (WEEKS + 1) * 7 * 86400000);
  console.log(`Rango: ${isoDate(fromDate)} → ${isoDate(toDate)}\n`);

  if (!DRY_RUN) initFirebase();

  // Diagnóstico: ¿qué tiene la Wayback Machine de alfabeta.net en general?
  try {
    const domRows = await cdxQuery({ url: 'alfabeta.net', matchType: 'domain', output: 'json', fl: 'timestamp,original', collapse: 'urlkey', limit: '10000' });
    console.log(`🔎 Wayback conoce ${domRows.length} URLs distintas de alfabeta.net (histórico total).`);
    const precio = domRows.filter(r => /\/precio\//i.test(r[1] || ''));
    console.log(`   de las cuales ${precio.length} son de /precio/. Muestra:`);
    precio.slice(0, 12).forEach(r => console.log(`     ${r[0]}  ${r[1]}`));
    if (!precio.length) domRows.slice(0, 8).forEach(r => console.log(`     ${r[0]}  ${r[1]}`));
  } catch (e) { console.log('🔎 Diagnóstico de dominio falló:', e.message); }
  console.log('');

  const puppeteer = require('puppeteer-extra');
  puppeteer.use(require('puppeteer-extra-plugin-stealth')());
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800'],
  });

  // perDate[YYYY-MM-DD][medName] = { doseName: price }
  const perDate = {};
  const stats = [];

  try {
    for (const [medName, config] of Object.entries(MEDICATIONS)) {
      console.log(`── ${medName} ──`);
      const stat = { med: medName, url: null, snapshots: 0, weeks: 0, points: 0, priced: 0 };
      try {
        const url = await discoverProductUrl(browser, config.searchTerm);
        stat.url = url;
        if (!url) { console.log('  ⚠ no se pudo descubrir la URL — se omite'); stats.push(stat); continue; }
        console.log(`  URL: ${url}`);

        const allTime = await waybackAllTimeCount(url);
        console.log(`  Wayback histórico total de esta página: ${allTime} capturas`);

        const snaps = await waybackSnapshots(url, fromDate, toDate);
        stat.snapshots = snaps.length;
        console.log(`  Wayback: ${snaps.length} snapshots (${snaps[0] ? isoDate(snaps[0].date) : '—'} → ${snaps.length ? isoDate(snaps[snaps.length-1].date) : '—'})`);
        if (!snaps.length) { stats.push(stat); await sleep(500); continue; }

        const weekly = pickWeekly(snaps, fromDate, toDate, WEEKS);
        stat.weeks = weekly.length;
        console.log(`  Elegidos ~semanales: ${weekly.length}`);

        for (const snap of weekly) {
          const date = isoDate(snap.date);
          try {
            const html = await fetchArchivedHtml(snap);
            const { prices } = parsePricesFromHtml(html, medName, config);
            const n = Object.keys(prices).length;
            if (n > 0) {
              (perDate[date] = perDate[date] || {})[medName] = prices;
              stat.points++;
              stat.priced += n;
              console.log(`    ${date}: ${n} dosis  (ej. ${Object.entries(prices)[0].map(String).join(' = ')})`);
            } else {
              console.log(`    ${date}: 0 dosis parseadas`);
            }
          } catch (e) {
            console.log(`    ${date}: error ${e.message}`);
          }
          await sleep(600); // cortesía con web.archive.org
        }
      } catch (e) {
        console.log(`  ✗ ${medName}: ${e.message}`);
      }
      stats.push(stat);
      await sleep(800);
    }
  } finally {
    await browser.close();
  }

  const dates = Object.keys(perDate).sort();
  console.log('\n════════ RESUMEN ════════');
  for (const s of stats) {
    console.log(`  ${s.med.padEnd(9)} url:${s.url ? 'ok' : 'NO'}  snaps:${s.snapshots}  semanas:${s.weeks}  puntos:${s.points}  dosis:${s.priced}`);
  }
  console.log(`  Fechas con datos: ${dates.length}${dates.length ? ` (${dates[0]} → ${dates[dates.length-1]})` : ''}`);

  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN: no se escribió nada. Muestra de fechas:');
    dates.slice(0, 6).forEach(d => console.log(`   ${d}: [${Object.keys(perDate[d]).join(', ')}]`));
    return;
  }

  if (!dates.length) {
    console.log('\n— No se encontraron datos para backfillear. Nada que escribir.');
    await admin.app().delete();
    return;
  }

  // Escribir cada fecha como un documento de priceHistory (id = fecha).
  let written = 0, skipped = 0;
  for (const date of dates) {
    const ref = db.collection('priceHistory').doc(date);
    if (!OVERWRITE) {
      const existing = await ref.get();
      if (existing.exists) { skipped++; continue; } // no pisar puntos ya cargados (ej. del scraper en vivo)
    }
    const ts = admin.firestore.Timestamp.fromDate(new Date(`${date}T12:00:00-03:00`));
    await ref.set({ ...perDate[date], timestamp: ts, source: 'backfill' }, { merge: true });
    written++;
  }
  console.log(`\n✅ Backfill escrito: ${written} fechas nuevas${skipped ? `, ${skipped} ya existían (no se pisaron)` : ''}.`);
  await admin.app().delete();
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}

module.exports = { pickWeekly, waybackSnapshots };
