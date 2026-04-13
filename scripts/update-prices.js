/**
 * GLP-1 Price Updater
 * Scrapes www.alfabeta.net and updates Firebase Firestore with current PVP prices.
 * - Checks manualMode flag in Firebase; if true, skips all updates
 * - Saves price history snapshots to Firestore when prices change
 * - Sends email notification when prices change (nodemailer + Gmail App Password)
 * Runs via GitHub Actions at 12AM, 6AM, 12PM, 6PM Argentina time (Mon–Fri).
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

puppeteer.use(StealthPlugin());

// --- Firebase Init ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const ADMIN_EMAIL = 'joselanglois@gmail.com';

// --- Medication config ---
const MEDICATIONS = {
  Mounjaro: {
    searchTerm: 'mounjaro',
    doses: [
      { dbName: '2.5mg (KwikPen x1)', pattern: /2[,.]5\s*mg/i },
      { dbName: '5mg (KwikPen x1)',    pattern: /\b5\s*mg/i },
    ],
  },
  Ozempic: {
    searchTerm: 'ozempic',
    doses: [
      { dbName: '0.25mg / 0.5mg (1.5ml + 6 ag)', pattern: /0[,.]25\s*mg.*0[,.]5\s*mg/i },
      { dbName: '1mg (3ml + 4 ag)',               pattern: /\b1\s*mg/i },
    ],
  },
  Wegovy: {
    searchTerm: 'wegovy',
    doses: [
      { dbName: '0.25mg (1.5ml + 4 ag)', pattern: /0[,.]25\s*mg/i },
      { dbName: '0.5mg (1.5ml + 4 ag)',  pattern: /0[,.]5\s*mg/i },
      { dbName: '1mg (3ml + 4 ag)',       pattern: /\b1\s*mg/i },
      { dbName: '1.7mg (3ml + 4 ag)',     pattern: /1[,.]7\s*mg/i },
      { dbName: '2.4mg (3ml + 4 ag)',     pattern: /2[,.]4\s*mg/i },
    ],
  },
  Dutide: {
    searchTerm: 'dutide',
    doses: [
      { dbName: '0.25mg (x4)', pattern: /0[,.]25\s*mg/i },
      { dbName: '0.5mg (x4)',  pattern: /0[,.]5\s*mg/i },
      { dbName: '1mg (x4)',    pattern: /\b1\s*mg/i },
    ],
  },
  Obetide: {
    searchTerm: 'obetide',
    doses: [
      { dbName: '0.25mg (x4)', pattern: /0[,.]25\s*mg/i },
      { dbName: '0.5mg (x4)',  pattern: /0[,.]5\s*mg/i },
      { dbName: '1mg (x4)',    pattern: /\b1\s*mg/i },
      { dbName: '1.7mg (x4)', pattern: /1[,.]7\s*mg/i },
      { dbName: '2.4mg (x4)', pattern: /2[,.]4\s*mg/i },
    ],
  },
};

// --- Helpers ---
function parsePrice(text) {
  const clean = text.replace(/\s/g, '').replace(/[^0-9.,]/g, '');
  if (!clean) return null;
  if (/,\d{1,2}$/.test(clean)) {
    return parseFloat(clean.replace(/\./g, '').replace(',', '.'));
  }
  return parseFloat(clean.replace(/\./g, ''));
}

function formatARS(val) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(val);
}

// --- Email ---
function buildEmailHtml(changedMeds, newPrices) {
  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  let html = `<h2 style="color:#1e40af;margin-bottom:4px">Actualización de precios GLP-1</h2>
              <p style="color:#64748b;margin-top:0">${now}</p>`;

  for (const medName of changedMeds) {
    const doses = newPrices[medName] || {};
    html += `<hr style="margin:16px 0"><h3 style="margin:0 0 8px">${medName}</h3>`;

    if (medName === 'Mounjaro') {
      const pvp25  = doses['2.5mg (KwikPen x1)'];
      const pvp5   = doses['5mg (KwikPen x1)'];
      if (pvp25 && pvp5) {
        const psp25  = pvp25 * 0.70;
        const psp5   = pvp5  * 0.70;
        const farm25 = psp25 * 0.80;
        const farm5  = psp5  * 0.80;
        html += `
          <p>Mounjaro 2,5MG cuesta <b>${formatARS(pvp25)}</b> y Mounjaro 5MG <b>${formatARS(pvp5)}</b>.</p>
          <p>Aplicando el descuento del 30% del programa Con Voz, el precio de
             Mounjaro 2,5MG queda en <b>${formatARS(psp25)}</b> y
             Mounjaro 5MG queda en <b>${formatARS(psp5)}</b>.</p>
          <p>Si a esto se le aplica el 20% de descuento que hacen algunas farmacias,
             Mounjaro 2,5MG quedaría en <b>${formatARS(farm25)}</b> y
             Mounjaro 5MG quedaría en <b>${formatARS(farm5)}</b>.</p>`;
      }
    } else {
      for (const [doseName, price] of Object.entries(doses)) {
        html += `<p>${doseName}: <b>${formatARS(price)}</b></p>`;
      }
    }
  }

  html += `<hr><p style="color:#94a3b8;font-size:12px">Fuente: alfabeta.net · Comparador GLP-1 Argentina</p>`;
  return html;
}

async function sendEmail(changedMeds, newPrices) {
  if (!GMAIL_APP_PASSWORD) {
    console.log('  ⚠ GMAIL_APP_PASSWORD no configurado — se omite el email');
    return;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: ADMIN_EMAIL, pass: GMAIL_APP_PASSWORD },
  });
  try {
    await transporter.sendMail({
      from: `"GLP-1 Comparador" <${ADMIN_EMAIL}>`,
      to: ADMIN_EMAIL,
      subject: `💊 GLP-1 precios actualizados: ${changedMeds.join(', ')}`,
      html: buildEmailHtml(changedMeds, newPrices),
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

async function scrapeMedication(browser, medName, config) {
  const html = await getProductPageHtml(browser, config.searchTerm);
  if (!html) return {};

  const $ = cheerio.load(html);
  const found = {};

  $('tr').each((_, el) => {
    const rowText = $(el).text().replace(/\s+/g, ' ').trim();
    if (!rowText) return;
    if (/PAMI|PAC\./i.test(rowText)) return;

    const priceMatch = rowText.match(/\$\s*([\d.,]+)/);
    if (!priceMatch) return;
    const price = parsePrice(priceMatch[1]);
    if (!price || price < 1000) return;

    const doseText = rowText.replace(/\$.*$/, '').trim();
    console.log(`  "${doseText.substring(0, 70)}" → ${formatARS(price)}`);

    for (const dose of config.doses) {
      if (dose.pattern.test(doseText) && !found[dose.dbName]) {
        found[dose.dbName] = price;
        console.log(`  ✓ ${dose.dbName}`);
      }
    }
  });

  return found;
}

async function main() {
  console.log(`\n[${new Date().toISOString()}] GLP-1 price update started`);
  console.log(`Chrome: ${CHROME_PATH}`);

  const docRef = db.collection('config').doc('prices');
  const doc = await docRef.get();
  if (!doc.exists) {
    console.error('No prices document in Firebase. Open the app first to initialize it.');
    process.exit(1);
  }

  const docData = doc.data();

  // Respect manual mode
  if (docData.manualMode) {
    console.log('\n⏸ Modo manual activo — actualización automática pausada');
    await admin.app().delete();
    return;
  }

  const currentDb = docData.db;

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800'],
  });

  const changedMeds = [];
  const newPricesForChanged = {};

  try {
    for (const [medName, config] of Object.entries(MEDICATIONS)) {
      console.log(`\n── ${medName} ──`);
      try {
        const prices = await scrapeMedication(browser, medName, config);

        if (Object.keys(prices).length === 0) {
          console.warn(`  ⚠ No prices found — skipping`);
          continue;
        }
        if (!currentDb[medName]) {
          console.warn(`  ⚠ Not found in Firebase DB — skipping`);
          continue;
        }

        let medChanged = false;
        const updatedDoses = currentDb[medName].doses.map(dose => {
          const newPvp = prices[dose.name];
          if (newPvp !== undefined) {
            if (newPvp !== dose.pvp) medChanged = true;
            return { ...dose, pvp: newPvp };
          }
          console.warn(`  ⚠ No match for: "${dose.name}"`);
          return dose;
        });

        if (medChanged) {
          changedMeds.push(medName);
          currentDb[medName].doses = updatedDoses;
          newPricesForChanged[medName] = prices;
          console.log(`  → Precios actualizados`);
        } else {
          console.log(`  → Sin cambios`);
        }

      } catch (err) {
        console.error(`  ✗ ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  } finally {
    await browser.close();
  }

  if (changedMeds.length > 0) {
    // 1. Update current prices in Firebase
    await docRef.set({
      db: currentDb,
      manualMode: false,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('\n✅ Precios actualizados en Firebase');

    // 2. Save daily history snapshot
    const today = new Date().toISOString().split('T')[0];
    await db.collection('priceHistory').doc(today).set(
      { ...newPricesForChanged, timestamp: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log(`📅 Historial guardado: ${today}`);

    // 3. Send email notification
    await sendEmail(changedMeds, newPricesForChanged);
  } else {
    console.log('\n— Sin cambios de precios en esta pasada');
  }

  await admin.app().delete();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
