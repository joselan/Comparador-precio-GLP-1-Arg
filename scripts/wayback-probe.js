/**
 * Sondeo de la Wayback Machine para alfabeta.net (solo lectura, sin credenciales).
 *
 * Busca en el índice CDX TODAS las URLs archivadas de alfabeta.net que mencionen
 * nuestros productos o sus principios activos, sin asumir el slug exacto de la
 * página. Sirve para responder con datos: ¿hay alguna página de precios de estos
 * medicamentos archivada en algún momento? (aunque esté bajo otra URL).
 *
 * No escribe nada. Corre en GitHub Actions (desde el dev sandbox archive.org está
 * bloqueado por la política de red).
 */
const UA = 'Mozilla/5.0 (compatible; glp1-comparador-probe/1.0)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function cdx(params, label) {
  const q = new URLSearchParams(params);
  const api = `https://web.archive.org/cdx/search/cdx?${q.toString()}`;
  try {
    const res = await fetch(api, { headers: { 'User-Agent': UA } });
    if (!res.ok) { console.log(`  [${label}] HTTP ${res.status}`); return []; }
    const rows = await res.json();
    return (Array.isArray(rows) && rows.length > 1) ? rows.slice(1) : [];
  } catch (e) {
    console.log(`  [${label}] error: ${e.message}`);
    return [];
  }
}

(async () => {
  console.log(`[${new Date().toISOString()}] Sondeo Wayback de alfabeta.net\n`);

  // 1) ¿Cuántas páginas /precio/ tiene archivadas en total? (muestra)
  const precio = await cdx({
    url: 'alfabeta.net', matchType: 'domain',
    filter: 'original:.*/precio/[^?]*',
    collapse: 'urlkey', output: 'json', fl: 'original,timestamp', limit: '5000',
  }, 'precio');
  console.log(`1) Páginas /precio/ archivadas (distintas): ${precio.length}`);
  precio.slice(0, 20).forEach(r => console.log(`     ${r[0]}`));
  await sleep(500);

  // 2) URLs archivadas que mencionan nuestros productos / principios activos.
  const drugs = ['mounjaro', 'ozempic', 'wegovy', 'dutide', 'obetide',
                 'tirzepatida', 'semaglutida', 'saxenda', 'victoza', 'trulicity', 'liraglutida'];
  const rx = `original:(?i).*(${drugs.join('|')}).*`;
  const hits = await cdx({
    url: 'alfabeta.net', matchType: 'domain', filter: rx,
    collapse: 'urlkey', output: 'json', fl: 'original,timestamp,statuscode', limit: '2000',
  }, 'drugs');
  console.log(`\n2) URLs archivadas que mencionan nuestros fármacos: ${hits.length}`);
  hits.slice(0, 40).forEach(r => console.log(`     ${r[1]}  ${r[2]}  ${r[0]}`));
  await sleep(500);

  // 3) Conteo por fármaco (cuántas capturas totales, cualquier URL).
  console.log(`\n3) Capturas totales por fármaco (cualquier URL de alfabeta):`);
  for (const d of drugs) {
    const rows = await cdx({
      url: 'alfabeta.net', matchType: 'domain',
      filter: `original:(?i).*${d}.*`, output: 'json', fl: 'timestamp', limit: '20000',
    }, d);
    console.log(`     ${d.padEnd(14)} ${rows.length} capturas`);
    await sleep(300);
  }

  console.log('\n════════ CONCLUSIÓN ════════');
  console.log(`  /precio/ archivadas: ${precio.length} · con nuestros fármacos: ${hits.length}`);
  console.log(hits.length ? '  → Hay páginas candidatas: revisar la lista de arriba.'
                          : '  → No hay ninguna página archivada que mencione estos fármacos.');
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
