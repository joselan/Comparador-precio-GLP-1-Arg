/**
 * Tests de parsing y matching de dosis del scraper.
 *
 * Cubre el bug que motivó estos controles: con las regex viejas, el patrón de
 * la dosis de 5 mg también matcheaba "2,5 mg", asignando el precio de la 2.5
 * también a la de 5. El matching por valor numérico exacto de mg lo evita.
 *
 * No requiere dependencias externas (las funciones son puras); corre con Node.
 */

const assert = require('assert');
const { parsePrice, extractMgValues, matchDose, MEDICATIONS } = require('./update-prices.js');

let failures = 0;
function check(desc, actual, expected) {
  let ok;
  try { assert.deepStrictEqual(actual, expected); ok = true; } catch { ok = false; }
  console.log(`${ok ? '✓' : '✗ FAIL'} ${desc} → ${JSON.stringify(actual)}${ok ? '' : ' (esperado ' + JSON.stringify(expected) + ')'}`);
  if (!ok) failures++;
}

// --- extractMgValues ---
check('extract "MOUNJARO 2,5 mg lap.prell.x 1"', extractMgValues('MOUNJARO 2,5 mg lap.prell.x 1'), [2.5]);
check('extract "MOUNJARO 5 mg lap.prell.x 1"', extractMgValues('MOUNJARO 5 mg lap.prell.x 1'), [5]);
check('extract "MOUNJARO 7,5 mg/0,6 ml x 3 ml"', extractMgValues('MOUNJARO 7,5 mg/0,6 ml x 3 ml'), [7.5]);
check('extract "MOUNJARO 10 mg KwikPen"', extractMgValues('MOUNJARO 10 mg KwikPen'), [10]);
check('extract "MOUNJARO 12,5 mg"', extractMgValues('MOUNJARO 12,5 mg'), [12.5]);
check('extract "OZEMPIC 0,25 mg y 0,5 mg x 1,5 ml + 6 ag"', extractMgValues('OZEMPIC 0,25 mg y 0,5 mg x 1,5 ml + 6 ag'), [0.25, 0.5]);
check('extract "WEGOVY 2,4 mg/0,75 ml"', extractMgValues('WEGOVY 2,4 mg/0,75 ml'), [2.4]);
check('extract sin mg "DUTIDE lap x 4"', extractMgValues('DUTIDE lap x 4'), []);
check('extract no confunde mcg', extractMgValues('ALGO 500 mcg x 1'), []);

// --- matchDose: el caso del bug ---
const mj = MEDICATIONS.Mounjaro.doses;
check('fila "2,5 mg" matchea SOLO la dosis 2.5', matchDose(mj, [2.5]).dose.dbName, '2.5mg (KwikPen x1)');
check('fila "5 mg" matchea SOLO la dosis 5', matchDose(mj, [5]).dose.dbName, '5mg (KwikPen x1)');
check('fila "7,5 mg" NO matchea la dosis 5', matchDose(mj, [7.5]).dose.dbName, '7.5mg (KwikPen x1)');
check('fila "10 mg" matchea la dosis 10', matchDose(mj, [10]).dose.dbName, '10mg (KwikPen x1)');
check('fila "12,5 mg" no matchea nada', matchDose(mj, [12.5]).dose, null);
check('fila "15 mg" no matchea nada', matchDose(mj, [15]).dose, null);

// --- matchDose: Ozempic combinada ---
const oz = MEDICATIONS.Ozempic.doses;
check('fila combinada [0.25, 0.5] matchea la dosis doble', matchDose(oz, [0.25, 0.5]).dose.dbName, '0.25mg / 0.5mg (1.5ml + 6 ag)');
check('fila suelta [0.5] no matchea nada en Ozempic', matchDose(oz, [0.5]).dose, null);
check('fila [1] matchea 1mg', matchDose(oz, [1]).dose.dbName, '1mg (3ml + 4 ag)');

// --- matchDose: Wegovy ---
const wg = MEDICATIONS.Wegovy.doses;
check('Wegovy [1.7] matchea 1.7mg', matchDose(wg, [1.7]).dose.dbName, '1.7mg (3ml + 4 ag)');
check('Wegovy [1] no matchea 1.7', matchDose(wg, [1]).dose.dbName, '1mg (3ml + 4 ag)');
check('Wegovy [0.25] matchea 0.25', matchDose(wg, [0.25]).dose.dbName, '0.25mg (1.5ml + 4 ag)');

// --- parsePrice ---
check('parsePrice "664.189,48"', parsePrice('664.189,48'), 664189.48);
check('parsePrice "664.189"', parsePrice('664.189'), 664189);
check('parsePrice "1.234.567,89"', parsePrice('1.234.567,89'), 1234567.89);

console.log(failures === 0 ? '\n✅ TODOS LOS TESTS PASARON' : `\n❌ ${failures} TESTS FALLARON`);
process.exit(failures === 0 ? 0 : 1);
