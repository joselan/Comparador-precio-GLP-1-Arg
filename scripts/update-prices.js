/**
 * GLP-1 Price Updater
 * Scrapes www.alfabeta.net and updates Firebase Firestore with current PVP prices.
 * Runs via GitHub Actions every 30 min from 7am to 7pm Argentina (UTC-3).
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

puppeteer.use(StealthPlugin());

// --- Firebase Init ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

// --- Medication config ---
// dbName must match the "name" field of each dose in Firebase.
// pattern matches the dose description text on the alfabeta product page.
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

// --- Parse Argentine price format: $554.050,07 ---
function parsePrice(text) {
  const clean = text.replace(/\s/g, '').replace(/[^0-9.,]/g, '');
  if (!clean) return null;
  if (/,\d{1,2}$/.test(clean)) {
    return parseFloat(clean.replace(/\./g, '').replace(',', '.'));
  }
  return parseFloat(clean.replace(/\./g, ''));
}

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

    // 1. Go to search page
    await page.goto('https://www.alfabeta.net/precio/buscar.html', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // 2. Type search term and submit
    const inputSel = 'input[name="str"], input[type="search"], input[type="text"]';
    await page.waitForSelector(inputSel, { timeout: 5000 });
    await page.focus(inputSel);
    await page.keyboard.type(searchTerm);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.keyboard.press('Enter'),
    ]);

    // 3. Click the first result link (.rprod is the product name element inside .resultsearch)
    const resultLink = await page.$('.resultsearch a, .rprod a, a.rprod');
    if (!resultLink) {
      // Try clicking the rprod div directly if it's the clickable element
      const rprod = await page.$('.rprod');
      if (rprod) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
          rprod.click(),
        ]);
      } else {
        console.log('  ⚠ No result link found in search results');
        return null;
      }
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
        resultLink.click(),
      ]);
    }

    const url = page.url();
    const title = await page.title();
    console.log(`  Product page: "${title}" | ${url}`);

    // 4. Dump all table rows for debug
    const html = await page.content();
    const $ = cheerio.load(html);
    const rows = [];
    $('tr').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length > 2 && text.length < 400) rows.push(text.substring(0, 200));
    });
    console.log(`  Table rows (${rows.length}):`);
    rows.slice(0, 20).forEach(r => console.log(`    • ${r}`));

    return html;
  } finally {
    await page.close();
  }
}

async function scrapeMedication(browser, medName, config) {
  const html = await getProductPageHtml(browser, config.searchTerm);
  if (!html) return {};

  const $ = cheerio.load(html);
  const found = {};

  // Try common table-based price structures
  $('tr').each((_, el) => {
    const rowText = $(el).text().replace(/\s+/g, ' ').trim();
    if (!rowText) return;

    // Skip PAMI / obra social rows
    if (/PAMI|PAC\./i.test(rowText)) return;

    // Look for price in the row
    const priceMatch = rowText.match(/\$\s*([\d.,]+)/);
    if (!priceMatch) return;
    const price = parsePrice(priceMatch[1]);
    if (!price || price < 1000) return;

    // Dose description is everything before the price
    const doseText = rowText.replace(/\$.*$/, '').trim();
    console.log(`  "${doseText.substring(0, 70)}" → $${price.toLocaleString('es-AR')}`);

    for (const dose of config.doses) {
      if (dose.pattern.test(doseText) && !found[dose.dbName]) {
        found[dose.dbName] = price;
        console.log(`  ✓ matched: ${dose.dbName}`);
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
      '--window-size=1280,800',
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

      await new Promise(r => setTimeout(r, 2000));
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
