/**
 * Tests del sync Mounjaro → calc-precio-mounjaro-arg:
 * - buildMounjaroCalcFields: mapea las dosis del comparador a {p25,p5,p75,p10}.
 * - planMounjaroSync: decide qué escribir y qué alertar (control de saltos ±20%).
 */
const { buildMounjaroCalcFields, planMounjaroSync, MOUNJARO_CALC, esAlerta } = require('./update-prices.js');

let failures = 0;
function check(desc, cond) {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${desc}`);
  if (!cond) failures++;
}

// --- Mapeo dosis → campos ---
const db = {
  Mounjaro: { lab: 'Adium', doses: [
    { name: '2.5mg (KwikPen x1)', pvp: 677473.27 },
    { name: '5mg (KwikPen x1)',   pvp: 927772.01 },
    { name: '7.5mg (KwikPen x1)', pvp: 1209205.02 },
    { name: '10mg (KwikPen x1)',  pvp: 1395236.56 },
  ] },
  Ozempic: { lab: 'Novo Nordisk', doses: [{ name: '1mg (3ml + 4 ag)', pvp: 386656.15 }] },
};
const fields = buildMounjaroCalcFields(db);
check('Mapea las 4 presentaciones', Object.keys(fields).length === 4);
check('p25 = PVP de 2.5mg', fields.p25 === 677473.27);
check('p5 = PVP de 5mg', fields.p5 === 927772.01);
check('p75 = PVP de 7.5mg', fields.p75 === 1209205.02);
check('p10 = PVP de 10mg', fields.p10 === 1395236.56);
check('No incluye otros productos', !('Ozempic' in fields));

// Dosis sin precio publicado → el campo se omite (no se escribe null)
const dbPartial = { Mounjaro: { doses: [
  { name: '2.5mg (KwikPen x1)', pvp: 677473.27 },
  { name: '7.5mg (KwikPen x1)', pvp: null },
] } };
const partial = buildMounjaroCalcFields(dbPartial);
check('Omite dosis sin PVP (null)', Object.keys(partial).length === 1 && partial.p25 === 677473.27);
check('Sin Mounjaro en la BD → {}', JSON.stringify(buildMounjaroCalcFields({})) === '{}');

// --- Control de saltos ---
const prev = { p25: 677473.27, p5: 927772.01, p75: 1209205.02, p10: 1395236.56 };

// Sin cambios → escribe (idempotente) pero changed=false
let plan = planMounjaroSync(fields, prev, 0.20);
check('Sin cambios: no marca changed', plan.changed === false && plan.alerts.length === 0);
check('Sin cambios: escribe los 4 (idempotente)', Object.keys(plan.toWrite).length === 4);

// Cambio moderado (+10%) → se escribe y marca changed
plan = planMounjaroSync({ ...fields, p25: 677473.27 * 1.10 }, prev, 0.20);
check('Cambio +10%: se escribe', plan.toWrite.p25 > 700000 && plan.alerts.length === 0);
check('Cambio +10%: marca changed', plan.changed === true);

// Salto brusco (+50%) → NO se escribe ese campo y genera alerta
plan = planMounjaroSync({ ...fields, p5: 927772.01 * 1.5 }, prev, 0.20);
check('Salto +50%: p5 NO se escribe', !('p5' in plan.toWrite));
check('Salto +50%: genera alerta con datos', plan.alerts.length === 1
  && plan.alerts[0].campo === 'p5'
  && plan.alerts[0].precio_anterior === 927772.01
  && Math.abs(plan.alerts[0].variacion_pct - 50) < 0.01);
check('Salto +50%: los otros 3 sí se escriben', Object.keys(plan.toWrite).length === 3);

// Caída brusca (-40%) → también alerta (valor absoluto)
plan = planMounjaroSync({ p10: 1395236.56 * 0.6 }, prev, 0.20);
check('Caída -40%: alerta y no escribe', plan.alerts.length === 1 && !('p10' in plan.toWrite));

// Umbral configurable: con 60% el mismo salto del 50% pasa
plan = planMounjaroSync({ p5: 927772.01 * 1.5 }, prev, 0.60);
check('Umbral 60%: el salto del 50% se escribe', plan.toWrite.p5 !== undefined && plan.alerts.length === 0);

// Primer llenado (sin doc previo) → escribe todo, sin alertas
plan = planMounjaroSync(fields, {}, 0.20);
check('Doc destino vacío: escribe los 4 sin alertas', Object.keys(plan.toWrite).length === 4 && plan.alerts.length === 0 && plan.changed === true);

// Config del destino documentada
check('Config destino: precios_mounjaro/actuales', MOUNJARO_CALC.collection === 'precios_mounjaro' && MOUNJARO_CALC.docId === 'actuales');

// --- Clasificación de alertas para el email (esAlerta) ---
// Disparan email:
check('Bloqueo es alerta', esAlerta('⛔ Wegovy 1mg: cambio de $ 100 a $ 500 (400%) BLOQUEADO por superar el 80%.'));
check('Cambio grande es alerta', esAlerta('⚠ Ozempic 1mg: cambio grande de $ 100 a $ 160 (60%) — aplicado, pero conviene verificarlo.'));
check('Salto Mounjaro es alerta', esAlerta('⚠ Mounjaro→calc 5mg: salto de $ 900.000 a $ 1.400.000 (55%) supera ±20% — NO se sobreescribió; queda en precios_mounjaro_alertas para revisar.'));
check('Falla de sync es alerta', esAlerta('Sync Mounjaro→calc falló: PERMISSION_DENIED (el comparador no se vio afectado).'));
check('Sin ningún precio es alerta', esAlerta('Ozempic: el scraper no encontró NINGÚN precio — ¿cambió la página de alfabeta?'));
check('Error de scraping es alerta', esAlerta('Mounjaro: error de scraping — Navigation timeout'));
// NO disparan email (advertencias informativas):
check('"sin match — se conserva" NO es alerta', !esAlerta('Ozempic 0.25mg / 0.5mg (1.5ml + 6 ag): sin match en la página — se conserva $ 322.213,46.'));
check('"MISMO PVP" NO es alerta', !esAlerta('⚠ Wegovy: "0.25 mg" y "0.5 mg" quedaron con el MISMO PVP ($ 322.213,46) — verificar que el matching sea correcto.'));
check('"no existe en la base" NO es alerta', !esAlerta('Saxenda: no existe en la base de Firebase — se omite.'));
check('"no hay PVPs de Mounjaro" NO es alerta', !esAlerta('Sync Mounjaro→calc: no hay PVPs de Mounjaro para sincronizar.'));

console.log(failures === 0 ? '\n✅ TODOS LOS TESTS DEL SYNC MOUNJARO PASARON' : `\n❌ ${failures} TESTS FALLARON`);
process.exit(failures === 0 ? 0 : 1);
