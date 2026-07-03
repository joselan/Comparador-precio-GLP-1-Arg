/**
 * GLP-1 Price Updater
 * Scrapes www.alfabeta.net and updates Firebase Firestore with current PVP prices.
 * - Checks manualMode flag in Firebase; if true, skips all updates
 * - Saves price history snapshots to Firestore when prices change
 * - Sends email notification when prices change (nodemailer + Gmail App Password)
 * Runs via GitHub Actions at 12AM, 6AM, 12PM, 6PM Argentina time (Mon–Fri).
 *
 * Controles de calidad del scraping:
 * - Cada dosis se identifica por su valor numérico exacto de mg (evita que
 *   "2,5 mg" matchee la dosis de 5 mg, como pasaba con las regex sueltas).
 * - Filas que matchean más de una dosis se descartan y generan advertencia.
 * - Cambios de precio > WARN_CHANGE (40%) se aplican pero se marcan para revisar.
 * - Cambios de precio > BLOCK_CHANGE (80%) se bloquean y requieren revisión manual.
 * - Dos dosis distintas que quedan con el mismo PVP generan advertencia.
 * - Si un producto no devuelve ningún precio se avisa por email; si NINGUNO
 *   devuelve precios, el job termina con error (falla visible en GitHub Actions).
 * - Modo simulación: `node update-prices.js --dry-run` scrapea y muestra qué
 *   haría sin escribir en Firebase ni enviar emails (lee la BD por REST público).
 */

// Las dependencias pesadas (puppeteer, cheerio, nodemailer, firebase-admin) se
// cargan de forma perezosa dentro de las funciones que las usan. Así el módulo
// se puede importar sin instalar nada (los tests de las funciones puras corren
// con Node pelado).

const DRY_RUN = process.argv.includes('--dry-run');

// --- Firebase Init (lazy; se omite en dry-run) ---
let admin = null;
let db = null;
function initFirebase() {
  admin = require('firebase-admin');
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
}

const FIREBASE_PROJECT_ID = 'comparador-precios-glp-1-arg';
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const ADMIN_EMAIL = 'joselanglois@gmail.com';

// Umbrales de control de cambios de precio (fracción sobre el precio anterior)
const WARN_CHANGE = parseFloat(process.env.WARN_CHANGE || '0.40');
const BLOCK_CHANGE = parseFloat(process.env.BLOCK_CHANGE || '0.80');

// --- Medication config ---
// Cada dosis declara los mg exactos que deben aparecer en la fila de alfabeta.
// `optional: true` = presentación anunciada pero quizás aún no publicada; su
// ausencia no genera advertencias.
const MEDICATIONS = {
  Mounjaro: {
    searchTerm: 'mounjaro',
    doses: [
      { dbName: '2.5mg (KwikPen x1)', mg: [2.5] },
      { dbName: '5mg (KwikPen x1)',   mg: [5] },
      { dbName: '7.5mg (KwikPen x1)', mg: [7.5], optional: true },
      { dbName: '10mg (KwikPen x1)',  mg: [10],  optional: true },
    ],
  },
  Ozempic: {
    searchTerm: 'ozempic',
    doses: [
      { dbName: '0.25mg / 0.5mg (1.5ml + 6 ag)', mg: [0.25, 0.5] },
      { dbName: '1mg (3ml + 4 ag)',               mg: [1] },
    ],
  },
  Wegovy: {
    searchTerm: 'wegovy',
    doses: [
      { dbName: '0.25mg (1.5ml + 4 ag)', mg: [0.25] },
      { dbName: '0.5mg (1.5ml + 4 ag)',  mg: [0.5] },
      { dbName: '1mg (3ml + 4 ag)',       mg: [1] },
      { dbName: '1.7mg (3ml + 4 ag)',     mg: [1.7] },
      { dbName: '2.4mg (3ml + 4 ag)',     mg: [2.4] },
    ],
  },
  Dutide: {
    searchTerm: 'dutide',
    doses: [
      { dbName: '0.25mg (x4)', mg: [0.25] },
      { dbName: '0.5mg (x4)',  mg: [0.5] },
      { dbName: '1mg (x4)',    mg: [1] },
    ],
  },
  Obetide: {
    searchTerm: 'obetide',
    doses: [
      { dbName: '0.25mg (x4)', mg: [0.25] },
      { dbName: '0.5mg (x4)',  mg: [0.5] },
      { dbName: '1mg (x4)',    mg: [1] },
      { dbName: '1.7mg (x4)',  mg: [1.7] },
      { dbName: '2.4mg (x4)',  mg: [2.4] },
    ],
  },
};

// --- Metadata canónica de cada producto ---
// Fuente de verdad de los campos que NO son precios (laboratorio, PSP, etc.).
// El scraper la aplica en cada corrida para mantener el documento de Firebase
// prolijo y alineado con la app (ej. Novo pasó de PSP escalonado a 30% fijo).
const PRODUCT_META = {
  Mounjaro: { lab: 'Adium',        psp: 'Con Voz',      hasPsp: true,  pspType: 'fixed', pspValue: 0.30, canSplit: true,  color: 'bg-blue-600' },
  Ozempic:  { lab: 'Novo Nordisk', psp: 'Novo a la Par', hasPsp: true, pspType: 'fixed', pspValue: 0.30, canSplit: true,  color: 'bg-teal-600' },
  Wegovy:   { lab: 'Novo Nordisk', psp: 'Novo a la Par', hasPsp: true, pspType: 'fixed', pspValue: 0.30, canSplit: true,  color: 'bg-teal-500' },
  Dutide:   { lab: 'Elea',         psp: '-',            hasPsp: false, canSplit: false, color: 'bg-purple-600' },
  Obetide:  { lab: 'Elea',         psp: '-',            hasPsp: false, canSplit: false, color: 'bg-purple-500' },
};

// Aplica PRODUCT_META sobre el db actual (sin tocar las dosis/precios).
// Devuelve la lista de cambios realizados (vacía si ya estaba prolijo).
function normalizeMeta(currentDb) {
  const changes = [];
  for (const [name, meta] of Object.entries(PRODUCT_META)) {
    const prod = currentDb[name];
    if (!prod) continue;
    for (const [k, v] of Object.entries(meta)) {
      if (prod[k] !== v) { changes.push(`${name}.${k}: ${JSON.stringify(prod[k])} → ${JSON.stringify(v)}`); prod[k] = v; }
    }
    // Productos sin PSP (Elea): no deben conservar pspType/pspValue viejos
    if (!meta.hasPsp) {
      for (const k of ['pspType', 'pspValue']) {
        if (k in prod) { changes.push(`${name}.${k}: eliminado`); delete prod[k]; }
      }
    }
  }
  return changes;
}

// Arma un snapshot COMPLETO de precios para el historial: para cada producto,
// un mapa dosis→PVP con TODAS las presentaciones que ya tienen precio publicado.
// Antes el historial guardaba sólo los productos que cambiaban ese día, así que
// en el gráfico "faltaban productos"; con el snapshot completo cada punto del
// historial tiene todos los productos.
function buildSnapshot(currentDb) {
  const snap = {};
  for (const [medName, prod] of Object.entries(currentDb || {})) {
    const doses = {};
    (prod.doses || []).forEach(d => {
      if (typeof d.pvp === 'number' && d.pvp > 0) doses[d.name] = d.pvp;
    });
    if (Object.keys(doses).length) snap[medName] = doses;
  }
  return snap;
}

// --- Helpers ---
function parsePrice(text) {
  const clean = text.replace(/\s/g, '').replace(/[^0-9.,]/g, '');
  if (!clean) return null;
  if (/,\d{1,2}$/.test(clean)) {
    return parseFloat(clean.replace(/\./g, '').replace(',', '.'));
  }
  return parseFloat(clean.replace(/\./g, ''));
}

// Extrae todos los valores "X mg" de un texto ("2,5 mg/0,6 ml" → [2.5]).
// Los "ml", "mcg" y demás unidades quedan afuera.
function extractMgValues(text) {
  const values = [];
  const re = /(\d+(?:[.,]\d+)?)\s*mg\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    values.push(parseFloat(m[1].replace(',', '.')));
  }
  return values;
}

// Devuelve la dosis cuyos mg esperados están TODOS presentes en la fila.
// Si más de una dosis (con igual especificidad) matchea, la fila es ambigua.
function matchDose(doses, mgValues) {
  const present = new Set(mgValues);
  const matches = doses.filter(d => d.mg.every(v => present.has(v)));
  if (matches.length === 0) return { dose: null };
  const maxSpecificity = Math.max(...matches.map(d => d.mg.length));
  const best = matches.filter(d => d.mg.length === maxSpecificity);
  if (best.length > 1) return { dose: null, ambiguous: best.map(d => d.dbName) };
  return { dose: best[0] };
}

function formatARS(val) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(val);
}

// --- Lectura pública por REST (para --dry-run, no necesita credenciales) ---
function decodeFirestoreValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('doubleValue' in v) return v.doubleValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decodeFirestoreFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeFirestoreValue);
  return null;
}
function decodeFirestoreFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeFirestoreValue(v);
  return out;
}
async function fetchPricesDocViaRest() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/config/prices`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firestore REST ${res.status}`);
  const json = await res.json();
  return decodeFirestoreFields(json.fields || {});
}

// --- Email ---
function buildEmailHtml(changedMeds, newPrices, warnings) {
  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  let html = `<h2 style="color:#1e40af;margin-bottom:4px">Actualización de precios GLP-1</h2>
              <p style="color:#64748b;margin-top:0">${now}</p>`;

  for (const medName of changedMeds) {
    const doses = newPrices[medName] || {};
    html += `<hr style="margin:16px 0"><h3 style="margin:0 0 8px">${medName}</h3>`;

    if (medName === 'Mounjaro') {
      for (const [doseName, price] of Object.entries(doses)) {
        const psp = price * 0.70;
        const farm = psp * 0.80;
        html += `
          <p><b>${doseName}</b>: PVP <b>${formatARS(price)}</b><br>
             Con el 30% del programa Con Voz queda en <b>${formatARS(psp)}</b>;
             sumando el 20% de descuento de algunas farmacias, en <b>${formatARS(farm)}</b>.</p>`;
      }
    } else {
      for (const [doseName, price] of Object.entries(doses)) {
        html += `<p>${doseName}: <b>${formatARS(price)}</b></p>`;
      }
    }
  }

  if (warnings.length > 0) {
    html += `<hr style="margin:16px 0"><h3 style="color:#b45309;margin:0 0 8px">⚠ Advertencias del scraper</h3>`;
    for (const w of warnings) {
      html += `<p style="color:#b45309;margin:4px 0">${w}</p>`;
    }
  }

  html += `<hr><p style="color:#94a3b8;font-size:12px">Fuente: alfabeta.net · Comparador GLP-1 Argentina</p>`;
  return html;
}

async function sendEmail(changedMeds, newPrices, warnings) {
  if (!GMAIL_APP_PASSWORD) {
    console.log('  ⚠ GMAIL_APP_PASSWORD no configurado — se omite el email');
    return;
  }
  const subject = changedMeds.length > 0
    ? `💊 GLP-1 precios actualizados: ${changedMeds.join(', ')}`
    : `⚠ GLP-1 scraper: advertencias (sin cambios de precios)`;
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: ADMIN_EMAIL, pass: GMAIL_APP_PASSWORD },
  });
  try {
    await transporter.sendMail({
      from: `"GLP-1 Comparador" <${ADMIN_EMAIL}>`,
      to: ADMIN_EMAIL,
      subject,
      html: buildEmailHtml(changedMeds, newPrices, warnings),
    });
    console.log('  ✉ Email enviado a', ADMIN_EMAIL);
  } catch (err) {
    console.error('  ✗ Error enviando email:', err.message);
  }
}

// --- Scraping ---
async function getProductPageHtml(browser, searchTerm) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-AR,es;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto('https://www.alfabeta.net/precio/buscar.html', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    const inputSel = 'input[name="str"], input[type="search"], input[type="text"]';
    await page.waitForSelector(inputSel, { timeout: 5000 });
    await page.focus(inputSel);
    await page.keyboard.type(searchTerm);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.keyboard.press('Enter'),
    ]);

    const resultLink = await page.$('.resultsearch a, .rprod a, a.rprod');
    if (!resultLink) {
      const rprod = await page.$('.rprod');
      if (rprod) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
          rprod.click(),
        ]);
      } else {
        console.log('  ⚠ No result link found');
        return null;
      }
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
        resultLink.click(),
      ]);
    }

    console.log(`  Product: ${await page.title()}`);
    return await page.content();
  } finally {
    await page.close();
  }
}

// Extrae los precios de una página de producto de alfabeta (misma estructura
// de tabla que usa el scraper en vivo). Función pura sobre el HTML: la reutiliza
// tanto el scraper actual como el backfill que lee snapshots viejos de la
// Wayback Machine. `medName`/`config` identifican el producto y sus dosis.
function parsePricesFromHtml(html, medName, config, { log = false } = {}) {
  const warnings = [];
  const found = {};
  if (!html) return { prices: found, warnings };

  const cheerio = require('cheerio');
  const $ = cheerio.load(html);

  $('tr').each((_, el) => {
    const rowText = $(el).text().replace(/\s+/g, ' ').trim();
    if (!rowText) return;
    if (/PAMI|PAC\./i.test(rowText)) return;

    const priceMatch = rowText.match(/\$\s*([\d.,]+)/);
    if (!priceMatch) return;
    const price = parsePrice(priceMatch[1]);
    if (!price || price < 1000) return;

    const doseText = rowText.replace(/\$.*$/, '').trim();
    const mgValues = extractMgValues(doseText);
    if (mgValues.length === 0) return;
    if (log) console.log(`  "${doseText.substring(0, 70)}" [${mgValues.join(' / ')} mg] → ${formatARS(price)}`);

    const { dose, ambiguous } = matchDose(config.doses, mgValues);
    if (ambiguous) {
      warnings.push(`${medName}: fila ambigua "${doseText.substring(0, 70)}" matchea ${ambiguous.join(' y ')} — se descarta.`);
      return;
    }
    if (!dose) return;

    if (found[dose.dbName] !== undefined) {
      if (found[dose.dbName] !== price) {
        warnings.push(`${medName} ${dose.dbName}: dos filas con precios distintos (${formatARS(found[dose.dbName])} vs ${formatARS(price)}) — se conserva el primero.`);
      }
      return;
    }
    found[dose.dbName] = price;
    if (log) console.log(`  ✓ ${dose.dbName}`);
  });

  return { prices: found, warnings };
}

async function scrapeMedication(browser, medName, config) {
  const warnings = [];
  const html = await getProductPageHtml(browser, config.searchTerm);
  if (!html) {
    warnings.push(`${medName}: la búsqueda en alfabeta no devolvió resultados.`);
    return { prices: {}, warnings };
  }

  // Control: verificar que aterrizamos en la página del producto correcto
  if (!html.toLowerCase().includes(config.searchTerm.toLowerCase())) {
    warnings.push(`${medName}: la página cargada no menciona "${config.searchTerm}" — posible producto equivocado, se descarta.`);
    return { prices: {}, warnings };
  }

  const { prices, warnings: parseWarnings } = parsePricesFromHtml(html, medName, config, { log: true });
  warnings.push(...parseWarnings);
  return { prices, warnings };
}

async function main() {
  console.log(`\n[${new Date().toISOString()}] GLP-1 price update started${DRY_RUN ? ' — MODO SIMULACIÓN (--dry-run)' : ''}`);
  console.log(`Chrome: ${CHROME_PATH}`);

  let docRef = null;
  let docData;
  if (DRY_RUN) {
    docData = await fetchPricesDocViaRest();
    if (!docData.db) {
      console.error('No prices document in Firebase.');
      process.exit(1);
    }
  } else {
    initFirebase();
    docRef = db.collection('config').doc('prices');
    const doc = await docRef.get();
    if (!doc.exists) {
      console.error('No prices document in Firebase. Open the app first to initialize it.');
      process.exit(1);
    }
    docData = doc.data();
  }

  // Respect manual mode
  if (docData.manualMode) {
    console.log('\n⏸ Modo manual activo — actualización automática pausada');
    if (!DRY_RUN) await admin.app().delete();
    return;
  }

  const currentDb = docData.db;

  // Normalizar metadata (laboratorio, PSP, colores) para dejar el documento prolijo
  const metaChanges = normalizeMeta(currentDb);
  const metaChanged = metaChanges.length > 0;
  if (metaChanged) {
    console.log('\n🔧 Metadata normalizada:');
    metaChanges.forEach(c => console.log('  - ' + c));
  }

  const puppeteer = require('puppeteer-extra');
  puppeteer.use(require('puppeteer-extra-plugin-stealth')());
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800'],
  });

  const changedMeds = [];
  const newPricesForChanged = {};
  const allWarnings = [];
  let structureChanged = false;
  let medsWithPrices = 0;

  try {
    for (const [medName, config] of Object.entries(MEDICATIONS)) {
      console.log(`\n── ${medName} ──`);
      try {
        const { prices, warnings } = await scrapeMedication(browser, medName, config);
        allWarnings.push(...warnings);

        if (!currentDb[medName]) {
          allWarnings.push(`${medName}: no existe en la base de Firebase — se omite.`);
          continue;
        }
        if (Object.keys(prices).length === 0) {
          allWarnings.push(`${medName}: el scraper no encontró NINGÚN precio — ¿cambió la página de alfabeta? Se conservan los precios actuales.`);
          continue;
        }
        medsWithPrices++;

        const oldDoses = currentDb[medName].doses;
        const oldByName = {};
        oldDoses.forEach(d => { oldByName[d.name] = d; });

        let medChanged = false;
        const updatedDoses = [];

        for (const doseCfg of config.doses) {
          const existing = oldByName[doseCfg.dbName];
          const oldPvp = existing ? existing.pvp : null;
          const newPvp = prices[doseCfg.dbName];

          // Sin precio scrapeado para esta dosis
          if (newPvp === undefined) {
            if (!doseCfg.optional) {
              allWarnings.push(`${medName} ${doseCfg.dbName}: sin match en la página — se conserva ${oldPvp ? formatARS(oldPvp) : 'sin precio'}.`);
            }
            if (existing) {
              updatedDoses.push(existing);
            } else {
              updatedDoses.push({ name: doseCfg.dbName, pvp: null });
              structureChanged = true;
              console.log(`  + Dosis nueva (aún sin precio publicado): ${doseCfg.dbName}`);
            }
            continue;
          }

          // Dosis nueva o sin precio previo: se aplica directo
          if (!oldPvp) {
            updatedDoses.push({ ...(existing || { name: doseCfg.dbName }), pvp: newPvp });
            medChanged = true;
            if (!existing) structureChanged = true;
            console.log(`  + ${doseCfg.dbName}: precio inicial ${formatARS(newPvp)}`);
            continue;
          }

          // Control de cambios bruscos
          const delta = Math.abs(newPvp - oldPvp) / oldPvp;
          if (newPvp !== oldPvp && delta > BLOCK_CHANGE) {
            allWarnings.push(`⛔ ${medName} ${doseCfg.dbName}: cambio de ${formatARS(oldPvp)} a ${formatARS(newPvp)} (${(delta * 100).toFixed(0)}%) BLOQUEADO por superar el ${(BLOCK_CHANGE * 100).toFixed(0)}%. Revisar y cargar manualmente si es correcto.`);
            updatedDoses.push(existing);
            continue;
          }
          if (newPvp !== oldPvp) {
            medChanged = true;
            if (delta > WARN_CHANGE) {
              allWarnings.push(`⚠ ${medName} ${doseCfg.dbName}: cambio grande de ${formatARS(oldPvp)} a ${formatARS(newPvp)} (${(delta * 100).toFixed(0)}%) — aplicado, pero conviene verificarlo.`);
            }
          }
          updatedDoses.push({ ...existing, pvp: newPvp });
        }

        // Conservar dosis que están en la BD pero no en la config del scraper
        for (const d of oldDoses) {
          if (!config.doses.some(cd => cd.dbName === d.name)) updatedDoses.push(d);
        }

        // Control: dos dosis distintas que quedaron con el MISMO precio
        for (let i = 0; i < updatedDoses.length; i++) {
          for (let j = i + 1; j < updatedDoses.length; j++) {
            const a = updatedDoses[i], b = updatedDoses[j];
            if (!a.pvp || !b.pvp || a.pvp !== b.pvp) continue;
            const oldA = oldByName[a.name] && oldByName[a.name].pvp;
            const oldB = oldByName[b.name] && oldByName[b.name].pvp;
            if (oldA && oldB && oldA === oldB) continue; // ya eran iguales (ej. Wegovy 0.25/0.5)
            allWarnings.push(`⚠ ${medName}: "${a.name}" y "${b.name}" quedaron con el MISMO PVP (${formatARS(a.pvp)}) — verificar que el matching sea correcto.`);
          }
        }

        if (medChanged) {
          changedMeds.push(medName);
          newPricesForChanged[medName] = prices;
          console.log(`  → Precios actualizados`);
        } else {
          console.log(`  → Sin cambios`);
        }
        currentDb[medName].doses = updatedDoses;

      } catch (err) {
        allWarnings.push(`${medName}: error de scraping — ${err.message}`);
        console.error(`  ✗ ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  } finally {
    await browser.close();
  }

  if (allWarnings.length > 0) {
    console.log('\n⚠ Advertencias:');
    allWarnings.forEach(w => console.log('  - ' + w));
  }

  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN: no se escribió en Firebase ni se enviaron emails.');
    console.log(`Cambios detectados: ${changedMeds.length > 0 ? changedMeds.join(', ') : 'ninguno'}`);
    console.log(`Metadata a normalizar: ${metaChanged ? metaChanges.length + ' cambios' : 'ninguno (ya prolijo)'}`);
    if (medsWithPrices === 0) {
      console.error('✗ Ningún producto devolvió precios.');
      process.exitCode = 1;
    }
    return;
  }

  if (changedMeds.length > 0 || structureChanged || metaChanged) {
    // 1. Update current prices in Firebase
    await docRef.set({
      db: currentDb,
      manualMode: docData.manualMode || false,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('\n✅ Precios actualizados en Firebase');
  }

  // 2. Guardar snapshot COMPLETO del día (todos los productos, no sólo los que
  // cambiaron) para que el gráfico del historial nunca tenga productos faltantes.
  // Se guarda siempre que al menos un producto haya devuelto precios (así no se
  // registran puntos "fantasma" si alfabeta estuvo caída en esta corrida).
  if (medsWithPrices > 0) {
    const today = new Date().toISOString().split('T')[0];
    const snapshot = buildSnapshot(currentDb);
    await db.collection('priceHistory').doc(today).set(
      { ...snapshot, timestamp: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log(`📅 Historial completo guardado: ${today} (${Object.keys(snapshot).length} productos)`);
  }

  // 3. Email: con cambios, o solo-advertencias para poder controlarlo
  if (changedMeds.length > 0 || allWarnings.length > 0) {
    await sendEmail(changedMeds, newPricesForChanged, allWarnings);
  } else {
    console.log('\n— Sin cambios de precios en esta pasada');
  }

  // Control: si ningún producto devolvió precios, fallar el job para que
  // GitHub Actions lo marque en rojo y sea visible.
  if (medsWithPrices === 0) {
    console.error('✗ Ningún producto devolvió precios — marcando el job como fallido.');
    process.exitCode = 1;
  }

  await admin.app().delete();
}

module.exports = { parsePrice, extractMgValues, matchDose, parsePricesFromHtml, MEDICATIONS, PRODUCT_META, normalizeMeta, buildSnapshot };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
