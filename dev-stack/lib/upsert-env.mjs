#!/usr/bin/env node
/**
 * upsert-env.mjs · Append-if-absent (idempotente por clave) de secretos sobre un env/<tier>.env EXISTENTE.
 *
 * Convención env ÚNICA del backend: un solo env/<tier>.env por servicio (config + secretos mergeados,
 * GITIGNORED). Este helper INYECTA claves de secreto SIN pisar la config ya presente:
 *   - clave AUSENTE            → se appendea (bajo un header de sección de secretos)
 *   - clave presente y VACÍA   → se reemplaza con el valor dado (secret-wins; recupera el comportamiento
 *                                 viejo `source dev; source secret`)
 *   - clave presente con VALOR → NO se toca (idempotente; no duplica)
 *
 * Soporta valores multilínea entre comillas dobles (los PEM). NO imprime valores de secretos.
 *
 * Uso:
 *   node upsert-env.mjs <ruta-development.env> KEY1=VALUE1 [KEY2=VALUE2 ...]
 * Los valores con saltos de línea (PEM) se pasan tal cual; el script los envuelve en comillas.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [, , filePath, ...pairs] = process.argv;
if (!filePath) {
  console.error('upsert-env: falta la ruta del env file');
  process.exit(1);
}
if (!existsSync(filePath)) {
  console.error(`upsert-env: no existe ${filePath} (la convención exige que development.env ya exista)`);
  process.exit(1);
}

// Parsea el env file respetando valores multilínea entre comillas. Devuelve Map<key, {value}>.
function parseKeys(text) {
  const lines = text.split('\n');
  const map = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (val.startsWith('"') && !(val.length > 1 && val.endsWith('"'))) {
      while (i + 1 < lines.length) {
        i++;
        val += '\n' + lines[i];
        if (lines[i].includes('"')) break;
      }
    }
    let s = val;
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1);
    map.set(key, { value: s });
  }
  return map;
}

// Renderiza KEY=VALUE; envuelve en comillas si el valor es multilínea o ya venía quoted.
function renderKV(key, value) {
  if (value.includes('\n')) return `${key}="${value}"`;
  return `${key}=${value}`;
}

let text = readFileSync(filePath, 'utf8');
const existing = parseKeys(text);
const toAppend = [];
let appended = 0, replaced = 0, skipped = 0;

for (const pair of pairs) {
  const idx = pair.indexOf('=');
  if (idx < 1) continue;
  const key = pair.slice(0, idx);
  const value = pair.slice(idx + 1);

  if (!existing.has(key)) {
    toAppend.push([key, value]);
    appended++;
  } else if (existing.get(key).value === '' && value !== '') {
    // reemplazar la línea single-line vacía `KEY=` en su sitio
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) {
      text = text.replace(re, renderKV(key, value));
      replaced++;
    } else {
      toAppend.push([key, value]);
      appended++;
    }
  } else {
    skipped++;
  }
}

if (toAppend.length > 0) {
  if (!text.endsWith('\n')) text += '\n';
  if (!text.includes('# --- secretos DEV (inyectados por boot)')) {
    text += '\n# --- secretos DEV (inyectados por boot, GITIGNORED). Idempotente por clave. ---\n';
  }
  for (const [k, v] of toAppend) text += renderKV(k, v) + '\n';
}

writeFileSync(filePath, text);
console.error(`upsert-env[${filePath.split('/services/')[1] ?? filePath}]: appended=${appended} replaced=${replaced} skipped=${skipped}`);
