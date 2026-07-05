/**
 * Test de la función mergeDb del frontend (src/index.html).
 *
 * mergeDb combina la estructura local (defaultDb: productos y dosis nuevos,
 * ej. Mounjaro 7.5/10 mg) con los precios que vienen de Firebase. Los precios
 * de Firebase mandan; las dosis que aún no están en Firebase se conservan desde
 * la base local (con pvp null hasta que se publiquen).
 *
 * La app vive en src/index.html, así que se extrae la función de ahí.
 * Está acoplado a esa definición: si el test no la encuentra, falla con un
 * mensaje claro para actualizar la extracción.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Se lee la FUENTE (src/index.html), no el index.html de la raíz (que es el
// build compilado y no tiene la definición legible de mergeDb).
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const match = html.match(/const mergeDb = ([\s\S]*?\n {8}};)/);
if (!match) {
  console.error('✗ No se encontró la función mergeDb en src/index.html — actualizá la extracción de test-mergedb.js.');
  process.exit(1);
}
// eslint-disable-next-line no-eval
const mergeDb = eval('(' + match[1].replace(/;\s*$/, '') + ')');

let failures = 0;
function check(desc, cond) {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${desc}`);
  if (!cond) failures++;
}

const base = {
  Mounjaro: { lab: 'Adium', color: 'bg-blue-600', doses: [
    { name: '2.5mg (KwikPen x1)', pvp: 612576.68 },
    { name: '5mg (KwikPen x1)', pvp: 829980.63 },
    { name: '7.5mg (KwikPen x1)', pvp: null },
    { name: '10mg (KwikPen x1)', pvp: null } ] },
  Ozempic: { lab: 'Novo', doses: [ { name: '1mg', pvp: 100 } ] },
};
const remote = {
  Mounjaro: { lab: 'Adium', color: 'bg-blue-600', doses: [
    { name: '2.5mg (KwikPen x1)', pvp: 664189.48 },
    { name: '5mg (KwikPen x1)', pvp: 927772.01 } ] },
  Ozempic: { lab: 'Novo', doses: [ { name: '1mg', pvp: 410193.83 } ] },
  ProductoSoloRemoto: { lab: 'X', doses: [ { name: '1mg', pvp: 5 } ] },
};

const merged = mergeDb(base, remote);

check('Mounjaro conserva las 4 dosis (2 de Firebase + 2 locales sin precio)', merged.Mounjaro.doses.length === 4);
check('2.5mg toma el precio de Firebase', merged.Mounjaro.doses[0].pvp === 664189.48);
check('5mg toma el precio de Firebase', merged.Mounjaro.doses[1].pvp === 927772.01);
check('7.5mg queda sin precio (null) hasta que se publique', merged.Mounjaro.doses[2].pvp === null);
check('10mg queda sin precio (null)', merged.Mounjaro.doses[3].pvp === null);
check('Orden de dosis preservado: 2.5, 5, 7.5, 10', merged.Mounjaro.doses.map(d => d.name.split('mg')[0]).join(',') === '2.5,5,7.5,10');
check('Ozempic toma el precio de Firebase', merged.Ozempic.doses[0].pvp === 410193.83);
check('Un producto que solo está en Firebase se conserva', !!merged.ProductoSoloRemoto);
check('Sin datos remotos, devuelve la base local tal cual', mergeDb(base, null) === base);

let passthroughOk = true;
try { assert.deepStrictEqual(mergeDb(base, undefined), base); } catch { passthroughOk = false; }
check('remote undefined también devuelve la base', passthroughOk);

console.log(failures === 0 ? '\n✅ TODOS LOS TESTS DE mergeDb PASARON' : `\n❌ ${failures} TESTS FALLARON`);
process.exit(failures === 0 ? 0 : 1);
