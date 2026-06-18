/**
 * Mint de un JWT de PASAJERO para LOAD TEST LOCAL (dev). Firma ES256 con la MISMA clave privada dev
 * (identity-service/env/development.env · JWT_PRIVATE_KEY_PEM) que el public-bff valida con su pública.
 * El JwtAuthGuard del BFF SOLO verifica firma + claims (no llama a identity GetUser), así que un token
 * bien firmado pasa sin que el usuario exista en DB → sirve para martillar el quote (read-only, sin gate KYC).
 *
 * SOLO dev/local: usa el keypair de desarrollo, token corto (2h), para medir capacidad del hot-path.
 * NO es un bypass de prod (prod usa otro keypair y el flujo OTP real).
 *
 * Uso:  TOKEN=$(node dev-stack/loadtest/mint-token.mjs)
 */
import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';

const SECRET = new URL('../../services/identity-service/env/development.env', import.meta.url);
const raw = readFileSync(SECRET, 'utf8');

// El PEM es un valor multi-línea entre comillas con newlines reales.
const m = raw.match(/JWT_PRIVATE_KEY_PEM="([\s\S]*?)"/);
if (!m) {
  console.error('mint-token: no encontré JWT_PRIVATE_KEY_PEM en development.env');
  process.exit(1);
}
const pem = m[1].trim();

const issuer = (raw.match(/JWT_ISSUER=(.*)/)?.[1] ?? 'veo-identity').trim();
const audience = (raw.match(/JWT_AUDIENCE=(.*)/)?.[1] ?? 'veo-app').trim();

const key = await importPKCS8(pem, 'ES256');

async function mint(sub) {
  return new SignJWT({ typ: 'passenger', roles: [], sid: `loadtest-${sub}` })
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(key);
}

// COUNT>0 → array JSON de N tokens con userId DISTINTO (cada VU su identidad → el rate-limit por
// IP:userId NO los agrupa, así se mide el SERVER y no el límite de 120/min/cliente). Sin COUNT → 1 token
// crudo (para el smoke con curl). El rate-limit igual keyea por IP; en local todos comparten 127.0.0.1,
// pero el contador es por IP+userId+ruta, así que userIds distintos = contadores independientes.
const count = Number(process.env.COUNT ?? 0);
if (count > 0) {
  const tokens = await Promise.all(
    Array.from({ length: count }, (_, i) => mint(`loadtest-passenger-${i}`)),
  );
  process.stdout.write(JSON.stringify(tokens));
} else {
  process.stdout.write(await mint(process.env.SUB ?? 'loadtest-passenger'));
}
