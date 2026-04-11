/**
 * GLP-1 Price Updater
 * Uses Puppeteer (headless Chrome) + puppeteer-extra-plugin-stealth to scrape
 * www.alfabeta.net and update Firebase Firestore with current PVP prices.
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

// Google Chrome is pre-installed on GitHub Actions ubuntu-latest runners
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

// --- Medication config ---
// dbName must match the "name" field in Firebase dose objects.
// searchTerm is appended to the alfabeta search URL.
// doses[].pattern matches against the product description text on the results page.
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

async function fetchPage(browser, url) {
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

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Extra wait for JS-rendered content or anti-bot challenges to resolve
    await new Promise(r => setTimeout(r, 4000));

    const title = await page.title();
    console.log(`  Title: "${title}"`);

    return await page.content();
  } finally {
    await page.close();
  }
}

async function scrapeMedication(browser, medName, config) {
  const url = `https://www.alfabeta.net/precio/buscar.html?str=${encodeURIComponent(config.searchTerm)}`;
  console.log(`  URL: ${url}`);

  const html = await fetchPage(browser, url);
  const $ = cheerio.load(html);
  const found = {};

  // --- Debug: show body text preview ---
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  console.log(`  Body preview (500): ${bodyText.substring(0, 500)}`);

  // --- Debug: log all leaf elements that contain price-like text ---
  const pricePattern = /\$\s*[\d.,]{4,}/;
  let priceElemsFound = 0;
  $('*').each((_, el) => {
    const children = $(el).children();
    if (children.length > 0) return; // only leaf nodes
    const text = $(el).text().trim();
    if (!pricePattern.test(text) || text.length > 250) return;
    const tag = el.tagName;
    const cls = $(el).attr('class') || '';
    console.log(`  [price-el] <${tag} class="${cls}"> ${text.substring(0, 150)}`);
    priceElemsFound++;
    if (priceElemsFound >= 10) return false; // stop after 10
  });

  if (priceElemsFound === 0) {
    console.log('  No price-like elements found on page.');
  }

  // TODO: fill in real parsing once we see the HTML structure from debug logs

  return found;
}

async function main() {
  console.log(`\n[${new Date().toISOString()}] GLP-1 price update started (alfabeta.net — debug mode)`);
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

  try {
    for (const [medName, config] of Object.entries(MEDICATIONS)) {
      console.log(`\n── ${medName} ──`);
      try {
        await scrapeMedication(browser, medName, config);
      } catch (err) {
        console.error(`  ✗ ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  } finally {
    await browser.close();
  }

  console.log('\nDebug run complete — no Firebase writes in this version.');
  console.log('Check logs above to see the HTML structure from alfabeta.net.');

  await admin.app().delete();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
