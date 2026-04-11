/**
 * GLP-1 Price Updater
 * Uses Puppeteer (headless Chrome) to scrape arg.kairosweb.com and update
 * Firebase Firestore with current PVP prices.
 * Runs via GitHub Actions every 30 min from 7am to 7pm Argentina (UTC-3).
 */

const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

// --- Firebase Init ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Google Chrome is pre-installed on GitHub Actions ubuntu-latest runners
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

// --- Medication config ---
// Patterns based on exact kairosweb row text (verified from screenshots):
//   Mounjaro:  "KwikPen 2.5mg /0.6ml Amp. x 1"  /  "KwikPen 5mg /0.6ml Amp. x 1"
//   Ozempic:   "0.25mg /0.5mg/dosis Lap. Prell. x 1.5ml +6 Agujas"  /  "1mg /dosis Lap. Prell. x 3ml + 4 Agujas"
//   Wegovy:    "0.25mg /dosis ..."  /  "0.5mg /dosis ..."  /  "1 mg /dosis ..."  /  "1.7mg /dosis ..."  /  "2.4mg /dosis ..."
//   Dutide:    "0.25mg Jer. Prellenada x 4"  /  "0.5mg Jer. Prellenada x 4"  /  "1mg Jer. Prellenada x 4"
//   Obetide:   idem Dutide + "1.7mg Jer. Prell. x 4"  /  "2.4mg Jer. Prell. x 4"
const MEDICATIONS = {
  Mounjaro: {
    url: 'https://arg.kairosweb.com/precio/producto-mounjaro-31483/',
    doses: [
      { dbName: '2.5mg (KwikPen x1)', pattern: /2[,.]5\s*mg/i },
      { dbName: '5mg (KwikPen x1)',    pattern: /KwikPen\s+5\s*mg/i },
    ],
  },
  Ozempic: {
    url: 'https://arg.kairosweb.com/precio/producto-ozempic-28575/',
    doses: [
      { dbName: '0.25mg / 0.5mg (1.5ml + 6 ag)', pattern: /0[,.]25\s*mg\s*\/\s*0[,.]5\s*mg/i },
      { dbName: '1mg (3ml + 4 ag)',               pattern: /^1\s*mg/i },
    ],
  },
  Wegovy: {
    url: 'https://arg.kairosweb.com/precio/producto-wegovy-31308/',
    doses: [
      { dbName: '0.25mg (1.5ml + 4 ag)', pattern: /^0[,.]25\s*mg/i },
      { dbName: '0.5mg (1.5ml + 4 ag)',  pattern: /^0[,.]5\s*mg/i },
      { dbName: '1mg (3ml + 4 ag)',       pattern: /^1\s*mg/i },
      { dbName: '1.7mg (3ml + 4 ag)',     pattern: /^1[,.]7\s*mg/i },
      { dbName: '2.4mg (3ml + 4 ag)',     pattern: /^2[,.]4\s*mg/i },
    ],
  },
  Dutide: {
    url: 'https://arg.kairosweb.com/precio/producto-dutide-inyectable-31011/',
    doses: [
      { dbName: '0.25mg (x4)', pattern: /^0[,.]25\s*mg/i },
      { dbName: '0.5mg (x4)',  pattern: /^0[,.]5\s*mg/i },
      { dbName: '1mg (x4)',    pattern: /^1\s*mg/i },
    ],
  },
  Obetide: {
    url: 'https://arg.kairosweb.com/precio/producto-obetide-31342/',
    doses: [
      { dbName: '0.25mg (x4)', pattern: /^0[,.]25\s*mg/i },
      { dbName: '0.5mg (x4)',  pattern: /^0[,.]5\s*mg/i },
      { dbName: '1mg (x4)',    pattern: /^1\s*mg/i },
      { dbName: '1.7mg (x4)', pattern: /^1[,.]7\s*mg/i },
      { dbName: '2.4mg (x4)', pattern: /^2[,.]4\s*mg/i },
    ],
  },
};

// --- Parse Argentine price format: $554.050,07 ---
function parsePrice(text) {
  const clean = text.replace(/\s/g, '').replace(/[^0-9.,]/g, '');
  if (!clean) return null;
  if (/,\d{1,2}$/.test(clean)) {
    return parseFloat(clean.replace(/\./g, '').replace(',', '.'));
  }
  return parseFloat(clean.replace(/\./g, ''));
}

async function fetchPage(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    return await page.content();
  } finally {
    await page.close();
  }
}

async function scrapeMedication(browser, medName, config) {
  const html = await fetchPage(browser, config.url);
  const $ = cheerio.load(html);
  const found = {};

  $('.precio').each((_, el) => {
    const priceText = $(el).text().trim();
    const price = parsePrice(priceText);
    if (!price || price < 1000) return;

    // Get the immediate row container
    const container = $(el).closest('tr, .row, li');
    const rowText = (container.length ? container : $(el).parent())
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    // Skip PAMI / obra social coverage rows
    if (/PAMI|PAC\./i.test(rowText)) return;

    // Dose name is at the start of the row, before the price
    const doseText = rowText.replace(/\$[\d.,]+.*$/, '').trim();

    console.log(`  "${doseText.substring(0, 70)}" → $${price.toLocaleString('es-AR')}`);

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
  console.log(`Using Chrome at: ${CHROME_PATH}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const docRef = db.collection('config').doc('prices');
  const doc = await docRef.get();
  if (!doc.exists) {
    console.error('No prices document in Firebase. Open the app first to initialize it.');
    await browser.close();
    process.exit(1);
  }

  const currentDb = doc.data().db;
  let anyUpdate = false;

  try {
    for (const [medName, config] of Object.entries(MEDICATIONS)) {
      console.log(`\n── ${medName} ──`);
      try {
        const prices = await scrapeMedication(browser, medName, config);

        if (Object.keys(prices).length === 0) {
          console.warn(`  ⚠  No prices found — skipping`);
          continue;
        }

        if (!currentDb[medName]) {
          console.warn(`  ⚠  Not found in Firebase DB — skipping`);
          continue;
        }

        currentDb[medName].doses = currentDb[medName].doses.map(dose => {
          if (prices[dose.name] !== undefined) {
            anyUpdate = true;
            return { ...dose, pvp: prices[dose.name] };
          }
          console.warn(`  ⚠  No match for: "${dose.name}"`);
          return dose;
        });

      } catch (err) {
        console.error(`  ✗ ${err.message}`);
      }

      // Polite delay between requests
      await new Promise(r => setTimeout(r, 1500));
    }
  } finally {
    await browser.close();
  }

  if (anyUpdate) {
    await docRef.set({
      db: currentDb,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('\n✅ Prices updated in Firebase');
  } else {
    console.log('\n⚠  No prices were updated');
  }

  await admin.app().delete();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
