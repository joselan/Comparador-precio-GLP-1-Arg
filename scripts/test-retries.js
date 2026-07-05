/**
 * Tests de withRetries: reintenta funciones async ante fallos transitorios
 * (timeouts de navegación de alfabeta) con backoff, y propaga el último error
 * si se agotan los intentos. Se usa baseDelay:0 para que el test sea instantáneo.
 */
const { withRetries } = require('./update-prices.js');

let failures = 0;
function check(desc, cond) {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${desc}`);
  if (!cond) failures++;
}

(async () => {
  // 1) Éxito al primer intento: se llama una sola vez.
  let calls = 0;
  let res = await withRetries(async () => { calls++; return 'ok'; }, { baseDelay: 0 });
  check('Éxito directo: devuelve el valor', res === 'ok');
  check('Éxito directo: llama una sola vez', calls === 1);

  // 2) Falla 2 veces y a la 3ra anda: recupera (default 3 intentos).
  calls = 0;
  res = await withRetries(async () => {
    calls++;
    if (calls < 3) throw new Error('Navigation timeout of 45000 ms exceeded');
    return 'recuperado';
  }, { baseDelay: 0, label: 'Mounjaro' });
  check('Recupera tras 2 fallos: devuelve el valor', res === 'recuperado');
  check('Recupera tras 2 fallos: hizo exactamente 3 intentos', calls === 3);

  // 3) Falla siempre: agota los intentos y propaga el ÚLTIMO error.
  calls = 0;
  let threw = null;
  try {
    await withRetries(async () => { calls++; throw new Error('fallo #' + calls); }, { tries: 3, baseDelay: 0 });
  } catch (e) { threw = e; }
  check('Falla siempre: lanza tras agotar', threw instanceof Error);
  check('Falla siempre: hizo 3 intentos', calls === 3);
  check('Falla siempre: propaga el último error', threw && threw.message === 'fallo #3');

  // 4) tries:1 = sin reintentos (un solo intento).
  calls = 0;
  try { await withRetries(async () => { calls++; throw new Error('x'); }, { tries: 1, baseDelay: 0 }); } catch (_) {}
  check('tries:1 no reintenta (1 intento)', calls === 1);

  // 5) Le pasa el número de intento a la función.
  const seen = [];
  await withRetries(async (attempt) => { seen.push(attempt); if (attempt < 2) throw new Error('r'); return 1; }, { baseDelay: 0 });
  check('Pasa el número de intento (1,2,...)', seen.join(',') === '1,2');

  console.log(failures === 0 ? '\n✅ TODOS LOS TESTS DE withRetries PASARON' : `\n❌ ${failures} TESTS FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})();
