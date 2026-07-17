#!/usr/bin/env node
/**
 * Regenera `packages/shared-config/tailwind/tokens.css` desde el canon `trustColors`.
 * Requiere el paquete buildeado (importa de dist/) — el script `generate:css` ya encadena el build.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trustColors } from '../dist/index.js';
import { renderTokensCss } from './render-css.mjs';

const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../shared-config/tailwind/tokens.css',
);
writeFileSync(out, renderTokensCss(trustColors));
console.log(`tokens.css regenerado → ${out}`);
