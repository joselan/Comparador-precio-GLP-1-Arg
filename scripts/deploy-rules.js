/**
 * Publica firestore.rules usando la API REST de Firebase Rules.
 *
 * Se hace por REST (y no con `firebase deploy`) a propósito: el CLI hace una
 * verificación previa contra serviceusage.googleapis.com que el service account
 * del scraper no tiene permitida (falla con 403 "Permission denied to get
 * service"). La API de Rules solo requiere permisos sobre firebaserules, que el
 * service account de Admin SDK sí posee.
 *
 * Requiere la variable de entorno FIREBASE_SERVICE_ACCOUNT (el mismo secret que
 * usa el scraper).
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const BASE = 'https://firebaserules.googleapis.com/v1';

async function main() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const projectId = serviceAccount.project_id;
  const source = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

  const cred = admin.credential.cert(serviceAccount);
  const { access_token } = await cred.getAccessToken();
  const authHeaders = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

  // 1. Crear el ruleset con el contenido de firestore.rules
  const rulesetRes = await fetch(`${BASE}/projects/${projectId}/rulesets`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content: source }] } }),
  });
  if (!rulesetRes.ok) {
    throw new Error(`No se pudo crear el ruleset (HTTP ${rulesetRes.status}): ${await rulesetRes.text()}`);
  }
  const rulesetName = (await rulesetRes.json()).name;
  console.log('✓ Ruleset creado:', rulesetName);

  // 2. Apuntar el release cloud.firestore al nuevo ruleset (PATCH; si no existe, POST)
  const releaseName = `projects/${projectId}/releases/cloud.firestore`;
  const patchRes = await fetch(`${BASE}/${releaseName}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ release: { name: releaseName, rulesetName } }),
  });

  if (patchRes.ok) {
    console.log('✓ Release actualizado.');
  } else if (patchRes.status === 404) {
    const createRes = await fetch(`${BASE}/projects/${projectId}/releases`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: releaseName, rulesetName }),
    });
    if (!createRes.ok) {
      throw new Error(`No se pudo crear el release (HTTP ${createRes.status}): ${await createRes.text()}`);
    }
    console.log('✓ Release creado.');
  } else {
    throw new Error(`No se pudo actualizar el release (HTTP ${patchRes.status}): ${await patchRes.text()}`);
  }

  console.log('✅ Reglas de Firestore publicadas correctamente.');
}

main().catch(err => {
  console.error('✗ Error publicando las reglas:', err.message);
  process.exit(1);
});
