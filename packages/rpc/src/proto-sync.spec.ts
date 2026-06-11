/**
 * Guard de FUENTE ÚNICA de los .proto. La copia canónica vive en packages/rpc/proto/; cada servicio
 * DUEÑO conserva una copia vendorizada SOLO porque su imagen Docker la sirve en runtime
 * (`COPY services/X-service/proto ./proto` + `join(__dirname, '../proto/x.proto')` en main.ts).
 *
 * Convención (única, sin listas duplicadas): `packages/rpc/proto/<name>.proto` ↔
 * `services/<name>-service/proto/<name>.proto`. Si este test falla, corré
 * `pnpm --filter @veo/rpc sync:protos` (propaga canónico → copias de los dueños).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTO_DIR, SERVICE_PACKAGE, SERVICE_PROTO, protoPathFor, type ServiceName } from './proto-paths.js';

const REPO_ROOT = join(PROTO_DIR, '..', '..', '..');
const SERVICES_DIR = join(REPO_ROOT, 'services');
const PROTO_EXT = '.proto';

/** services/<name>-service/proto/<name>.proto — la copia de deploy del servicio dueño. */
function ownerCopyPath(protoFile: string): string {
  const name = basename(protoFile, PROTO_EXT);
  return join(SERVICES_DIR, `${name}-service`, 'proto', protoFile);
}

const canonicalFiles = readdirSync(PROTO_DIR).filter((f) => f.endsWith(PROTO_EXT));

describe('protos canónicos (packages/rpc/proto) — fuente única', () => {
  it('cada ServiceName de proto-paths tiene su .proto canónico', () => {
    for (const service of Object.keys(SERVICE_PROTO) as ServiceName[]) {
      expect(existsSync(protoPathFor(service)), `falta canónico para ${service}`).toBe(true);
    }
  });

  it('no hay .proto canónicos huérfanos (todos referenciados por SERVICE_PROTO)', () => {
    expect(canonicalFiles.sort()).toEqual(Object.values(SERVICE_PROTO).sort());
  });

  it('el package declarado en cada .proto coincide con SERVICE_PACKAGE', () => {
    for (const [service, file] of Object.entries(SERVICE_PROTO) as [ServiceName, string][]) {
      const content = readFileSync(join(PROTO_DIR, file), 'utf8');
      const match = /^package\s+([\w.]+);/m.exec(content);
      expect(match?.[1], `package de ${file}`).toBe(SERVICE_PACKAGE[service]);
    }
  });

  it('la copia vendorizada de cada servicio dueño es byte-idéntica al canónico', () => {
    for (const file of canonicalFiles) {
      const ownerCopy = ownerCopyPath(file);
      expect(existsSync(ownerCopy), `falta copia de deploy: ${ownerCopy}`).toBe(true);
      const canonical = readFileSync(join(PROTO_DIR, file), 'utf8');
      const vendored = readFileSync(ownerCopy, 'utf8');
      expect(vendored, `${ownerCopy} drifteó del canónico — corré sync:protos`).toBe(canonical);
    }
  });

  it('ningún servicio vendoriza protos AJENOS (los consumidores cargan de @veo/rpc)', () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(SERVICES_DIR)) {
      const protoDir = join(SERVICES_DIR, entry, 'proto');
      if (!existsSync(protoDir)) continue;
      for (const file of readdirSync(protoDir).filter((f) => f.endsWith(PROTO_EXT))) {
        if (entry !== `${basename(file, PROTO_EXT)}-service`) offenders.push(join(entry, 'proto', file));
      }
    }
    expect(offenders, 'copias de consumidor detectadas — usá @veo/rpc').toEqual([]);
  });
});
