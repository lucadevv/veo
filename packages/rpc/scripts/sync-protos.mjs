/**
 * Propaga los .proto CANÓNICOS (packages/rpc/proto) a la copia de deploy de cada servicio dueño
 * (services/<name>-service/proto/<name>.proto). Los Dockerfiles copian esa carpeta al runner y
 * main.ts la carga por path relativo — por eso la copia existe; este script (y el guard
 * src/proto-sync.spec.ts) garantizan que NUNCA drifteen. Editá SIEMPRE el canónico y corré:
 *   pnpm --filter @veo/rpc sync:protos
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = join(here, '..', 'proto');
const SERVICES_DIR = join(here, '..', '..', '..', 'services');

let synced = 0;
for (const file of readdirSync(PROTO_DIR).filter((f) => f.endsWith('.proto'))) {
  const ownerProtoDir = join(SERVICES_DIR, `${basename(file, '.proto')}-service`, 'proto');
  if (!existsSync(ownerProtoDir)) continue;
  copyFileSync(join(PROTO_DIR, file), join(ownerProtoDir, file));
  console.log(`sync ${file} -> ${ownerProtoDir}`);
  synced += 1;
}
console.log(`${synced} protos sincronizados (canónico -> copia de deploy).`);
