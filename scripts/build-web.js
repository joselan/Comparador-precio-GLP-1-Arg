#!/usr/bin/env node
/**
 * Build del front.
 *
 * Toma src/index.html (la fuente EDITABLE: JSX inline + clases Tailwind, con el
 * Tailwind Play CDN y Babel como venía) y genera el index.html de la RAÍZ ya
 * optimizado para producción:
 *
 *   - Transpila el JSX a JS común  →  el navegador ya no baja ni corre Babel.
 *   - Genera un CSS de Tailwind real (solo las clases usadas) y lo inyecta inline
 *     →  el navegador ya no baja ni compila el Tailwind Play CDN (y no hay parpadeo).
 *   - Fija versiones exactas de React/ReactDOM.
 *
 * El index.html resultante se sirve igual de estático que hoy (Vercel/Netlify),
 * así que NO cambia nada del hosting. Para editar la app se toca src/index.html.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const babel = require('@babel/core');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const OUT = path.join(ROOT, 'index.html');

let html = fs.readFileSync(SRC, 'utf8');

// 1) CSS de Tailwind (usa tailwind.config.js de la raíz, que escanea src/index.html).
const tmpIn = path.join(ROOT, '.tw-input.css');
const tmpOut = path.join(ROOT, '.tw-output.css');
fs.writeFileSync(tmpIn, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
const twBin = path.join(ROOT, 'node_modules', '.bin', 'tailwindcss');
execFileSync(twBin, ['-i', tmpIn, '-o', tmpOut, '--minify'], { cwd: ROOT, stdio: 'inherit' });
const css = fs.readFileSync(tmpOut, 'utf8').trim();
fs.unlinkSync(tmpIn);
fs.unlinkSync(tmpOut);

// 2) Transpilar el JSX del <script type="text/babel"> a JS común (runtime clásico:
//    usa React.createElement, y React está global via UMD).
const appMatch = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!appMatch) throw new Error('No se encontró el <script type="text/babel"> en src/index.html');
let compiled = babel.transform(appMatch[1], {
  presets: ['@babel/preset-react'],
  compact: false,
  comments: false,
  babelrc: false,
  configFile: false,
}).code;
// Defensa: que ningún string rompa el cierre del <script> inline.
compiled = compiled.replace(/<\/(script)/gi, '<\\/$1');

// 3) Reemplazos en el HTML.
// Ojo: se usan funciones de reemplazo (no strings) porque `css` y `compiled` pueden
// contener secuencias `$` (ej. `'$'` en el JS), que String.replace interpretaría.
const before = html;
html = html.replace('    <script src="https://cdn.tailwindcss.com"></script>\n', '');       // Play CDN fuera
html = html.replace(/    <script>\s*tailwind\.config[\s\S]*?<\/script>/, () => `    <style>${css}</style>`); // config inline → CSS
html = html.replace('    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>\n', ''); // Babel fuera
html = html.replace('react@18/umd/react.production.min.js', 'react@18.3.1/umd/react.production.min.js');
html = html.replace('react-dom@18/umd/react-dom.production.min.js', 'react-dom@18.3.1/umd/react-dom.production.min.js');
html = html.replace(/<script type="text\/babel">[\s\S]*?<\/script>/, () => `<script>\n${compiled}\n    </script>`);

if (html === before) throw new Error('Los reemplazos no cambiaron nada — ¿cambió el <head> de src/index.html?');
for (const needle of ['cdn.tailwindcss.com', '@babel/standalone', 'type="text/babel"']) {
  if (html.includes(needle)) throw new Error('El build dejó una referencia que debía eliminarse: ' + needle);
}

// 4) Marca de archivo generado.
const banner = '<!-- ARCHIVO GENERADO por scripts/build-web.js desde src/index.html — NO editar a mano. -->';
html = html.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n' + banner);

fs.writeFileSync(OUT, html);
console.log(`✓ index.html generado: ${(html.length / 1024).toFixed(1)} KB (CSS inline: ${(css.length / 1024).toFixed(1)} KB)`);
