/**
 * Tests de normalizeMeta: deja la metadata de cada producto alineada con
 * PRODUCT_META sin tocar las dosis/precios, y limpia campos viejos.
 */
const assert = require('assert');
const { normalizeMeta, PRODUCT_META } = require('./update-prices.js');

let failures = 0;
function check(desc, cond) {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${desc}`);
  if (!cond) failures++;
}

// Simula el estado viejo en Firebase: Novo con PSP escalonado y Elea con pspType colgado
const db = {
  Ozempic: { lab: 'Novo Nordisk', psp: 'Novo a la Par', hasPsp: true, pspType: 'progressive', canSplit: true, color: 'bg-teal-600', doses: [{ name: '1mg (3ml + 4 ag)', pvp: 410193.83 }] },
  Wegovy:  { lab: 'Novo Nordisk', psp: 'Novo a la Par', hasPsp: true, pspType: 'progressive', canSplit: true, color: 'bg-teal-500', doses: [{ name: '0.25mg (1.5ml + 4 ag)', pvp: 341828.19 }] },
  Dutide:  { lab: 'Elea', psp: '-', hasPsp: false, pspType: 'progressive', pspValue: 0.25, canSplit: false, color: 'bg-purple-600', doses: [{ name: '1mg (x4)', pvp: 163154.09 }] },
  Mounjaro:{ lab: 'Adium', psp: 'Con Voz', hasPsp: true, pspType: 'fixed', pspValue: 0.30, canSplit: true, color: 'bg-blue-600', doses: [{ name: '5mg (KwikPen x1)', pvp: 927772.01 }] },
};

const changes = normalizeMeta(db);
check('Reporta cambios (había metadata desactualizada)', changes.length > 0);

// Novo → PSP fijo 30%
check('Ozempic pspType queda "fixed"', db.Ozempic.pspType === 'fixed');
check('Ozempic pspValue queda 0.30', db.Ozempic.pspValue === 0.30);
check('Wegovy pspType queda "fixed"', db.Wegovy.pspType === 'fixed');
check('Wegovy pspValue queda 0.30', db.Wegovy.pspValue === 0.30);

// Elea → sin campos de PSP
check('Dutide pierde pspType (sin PSP)', !('pspType' in db.Dutide));
check('Dutide pierde pspValue (sin PSP)', !('pspValue' in db.Dutide));
check('Dutide sigue hasPsp:false', db.Dutide.hasPsp === false);

// Mounjaro ya estaba bien → sin tocar sus valores
check('Mounjaro conserva pspType fixed / pspValue 0.30', db.Mounjaro.pspType === 'fixed' && db.Mounjaro.pspValue === 0.30);

// Las dosis/precios NO se tocan
check('Ozempic conserva sus dosis y precio', db.Ozempic.doses[0].pvp === 410193.83);
check('Mounjaro conserva su precio', db.Mounjaro.doses[0].pvp === 927772.01);

// Idempotente: segunda pasada no reporta cambios
const changes2 = normalizeMeta(db);
check('Segunda pasada es idempotente (sin cambios)', changes2.length === 0);

// PRODUCT_META cubre los 5 productos
check('PRODUCT_META tiene los 5 productos', ['Mounjaro','Ozempic','Wegovy','Dutide','Obetide'].every(k => k in PRODUCT_META));

console.log(failures === 0 ? '\n✅ TODOS LOS TESTS DE normalizeMeta PASARON' : `\n❌ ${failures} TESTS FALLARON`);
process.exit(failures === 0 ? 0 : 1);
