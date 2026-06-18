#!/usr/bin/env node
/**
 * setup-preview-tunnel.mjs · Crea/asegura el Cloudflare Tunnel + DNS de PREVIEW para VEO. Idempotente.
 *
 *   source infra/cloudflare/env/local.env && node infra/cloudflare/setup-preview-tunnel.mjs
 *
 * Lee CLOUDFLARE_API_TOKEN / _ACCOUNT_ID / _ZONE de env. Tunnel "veo-preview" remotely-managed
 * (config_src=cloudflare): el ingress se setea por API; cloudflared en el VPS solo necesita el token.
 * Guarda el connector token en infra/cloudflare/env/local.env (gitignored) SIN imprimirlo.
 * Crea CNAME proxied <host> → <tunnelId>.cfargotunnel.com para cada hostname de preview.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const ZONE_NAME = process.env.CLOUDFLARE_ZONE ?? 'yoveoapp.com';
if (!TOKEN || !ACCOUNT) { console.error('Falta CLOUDFLARE_API_TOKEN o _ACCOUNT_ID (source local.env)'); process.exit(1); }

const TUNNEL_NAME = 'veo-preview';
const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

// hostname → servicio interno (nombre de contenedor en veo-net : puerto). Se finaliza con el compose.
// Subdominios PLANOS (3er nivel) → cubiertos por el cert Universal *.yoveoapp.com.
// (api.preview.* sería 4º nivel y el Universal SSL no lo cubre → handshake failure.)
const INGRESS = [
  { host: 'api-preview.yoveoapp.com', service: 'http://public-bff:4001' },
  { host: 'driver-api-preview.yoveoapp.com', service: 'http://driver-bff:4002' },
  { host: 'admin-api-preview.yoveoapp.com', service: 'http://admin-bff:4003' },
];

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: H });
  const json = await res.json();
  if (!json.success) throw new Error(`CF ${path} → ${JSON.stringify(json.errors)}`);
  return json.result;
}

async function main() {
  // 1) zone id
  const zones = await cf(`/zones?name=${ZONE_NAME}`);
  const zoneId = zones[0]?.id;
  if (!zoneId) throw new Error(`zona ${ZONE_NAME} no encontrada`);
  console.log(`zona ${ZONE_NAME} → ${zoneId}`);

  // 2) tunnel find-or-create (idempotente)
  const existing = await cf(`/accounts/${ACCOUNT}/cfd_tunnel?name=${TUNNEL_NAME}&is_deleted=false`);
  let tunnel = existing[0];
  if (tunnel) {
    console.log(`tunnel "${TUNNEL_NAME}" ya existe → ${tunnel.id}`);
  } else {
    tunnel = await cf(`/accounts/${ACCOUNT}/cfd_tunnel`, {
      method: 'POST',
      body: JSON.stringify({ name: TUNNEL_NAME, config_src: 'cloudflare' }),
    });
    console.log(`tunnel "${TUNNEL_NAME}" creado → ${tunnel.id}`);
  }
  const tunnelId = tunnel.id;

  // 3) connector token → guardar en local.env SIN imprimir
  const token = await cf(`/accounts/${ACCOUNT}/cfd_tunnel/${tunnelId}/token`);
  const envPath = 'infra/cloudflare/env/local.env';
  let env = readFileSync(envPath, 'utf8');
  env = /^CLOUDFLARE_TUNNEL_TOKEN=/m.test(env)
    ? env.replace(/^CLOUDFLARE_TUNNEL_TOKEN=.*$/m, `CLOUDFLARE_TUNNEL_TOKEN=${token}`)
    : env.replace(/\s*$/, '') + `\nCLOUDFLARE_TUNNEL_TOKEN=${token}\n`;
  writeFileSync(envPath, env);
  console.log('connector token → guardado en local.env (gitignored, no se muestra)');

  // 4) ingress (remotely-managed)
  await cf(`/accounts/${ACCOUNT}/cfd_tunnel/${tunnelId}/configurations`, {
    method: 'PUT',
    body: JSON.stringify({
      config: {
        ingress: [
          ...INGRESS.map(({ host, service }) => ({ hostname: host, service })),
          { service: 'http_status:404' },
        ],
      },
    }),
  });
  console.log(`ingress seteado (${INGRESS.length} hostnames + 404 catch-all)`);

  // 5) DNS CNAME proxied → <tunnelId>.cfargotunnel.com (upsert)
  const target = `${tunnelId}.cfargotunnel.com`;
  const records = await cf(`/zones/${zoneId}/dns_records?per_page=200`);
  for (const { host } of INGRESS) {
    const found = records.find((r) => r.name === host);
    const body = JSON.stringify({ type: 'CNAME', name: host, content: target, proxied: true });
    if (found) {
      await cf(`/zones/${zoneId}/dns_records/${found.id}`, { method: 'PUT', body });
      console.log(`  DNS ↻ ${host} → ${target}`);
    } else {
      await cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body });
      console.log(`  DNS + ${host} → ${target}`);
    }
  }
  console.log('\n✓ Tunnel + DNS de preview listos. (502 hasta que el VPS levante cloudflared + servicios.)');
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
