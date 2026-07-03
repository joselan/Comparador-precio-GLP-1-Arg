/**
 * Tests de buildSnapshot: arma el snapshot completo del historial (dosis→PVP
 * de TODOS los productos con precio publicado), que es lo que se guarda en
 * priceHistory para que el gráfico no tenga productos faltantes.
 */
const assert = require('assert');
const { buildSnapshot } = require('./update-prices.js');

let failures = 0;
function check(desc, cond) {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${desc}`);
  if (!cond) failures++;
}

const db = {
  Mounjaro: { lab: 'Adium', doses: [
    { name: '2.5mg (KwikPen x1)', pvp: 612576.68 },
    { name: '5mg (KwikPen x1)', pvp: 829980.63 },
    { name: '7.5mg (KwikPen x1)', pvp: null },   // sin precio aún
    { name: '10mg (KwikPen x1)', pvp: null },
  ] },
  Ozempic: { lab: 'Novo Nordisk', doses: [
    { name: '0.25mg / 0.5mg (1.5ml + 6 ag)', pvp: 322213.46 },
    { name: '1mg (3ml + 4 ag)', pvp: 386656.15 },
  ] },
  Dutide: { lab: 'Elea', doses: [
    { name: '0.25mg (x4)', pvp: 114334.23 },
  ] },
};

const snap = buildSnapshot(db);

// Incluye TODOS los productos que tienen al menos una dosis con precio.
check('Incluye los 3 productos', Object.keys(snap).length === 3
  && snap.Mounjaro && snap.Ozempic && snap.Dutide);

// Guarda dosis→PVP con las presentaciones que tienen precio.
check('Mounjaro sólo con dosis con precio (2 de 4)', Object.keys(snap.Mounjaro).length === 2);
check('Mounjaro 5mg con su PVP', snap.Mounjaro['5mg (KwikPen x1)'] === 829980.63);
check('Omite dosis sin precio (7.5mg no está)', !('7.5mg (KwikPen x1)' in snap.Mounjaro));
check('Ozempic con sus 2 dosis', Object.keys(snap.Ozempic).length === 2);
check('Dutide presente', snap.Dutide['0.25mg (x4)'] === 114334.23);

// Un producto sin ninguna dosis con precio no aparece.
const snap2 = buildSnapshot({ Fantasma: { doses: [{ name: 'x', pvp: null }] } });
check('Producto sin precios no se incluye', !('Fantasma' in snap2) && Object.keys(snap2).length === 0);

// Robustez: entradas vacías / nulas no rompen.
check('buildSnapshot(undefined) → {}', JSON.stringify(buildSnapshot(undefined)) === '{}');
check('buildSnapshot({}) → {}', JSON.stringify(buildSnapshot({})) === '{}');

// El snapshot es serializable a JSON (se guarda tal cual en Firestore).
assert.doesNotThrow(() => JSON.parse(JSON.stringify(snap)));

console.log(failures === 0 ? '\n✅ TODOS LOS TESTS DE buildSnapshot PASARON' : `\n❌ ${failures} TESTS FALLARON`);
process.exit(failures === 0 ? 0 : 1);
