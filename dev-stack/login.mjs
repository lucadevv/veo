#!/usr/bin/env node
/**
 * login · Auto-login del SUPERADMIN de dev → cookies de sesión listas para pegar (solo dev).
 *
 * El admin usa MFA TOTP: loguear a mano obliga a abrir el authenticator y tipear 6 dígitos que rotan
 * cada 30s. Este script lo automatiza: calcula el TOTP vivo, hace el POST /auth/login contra admin-bff
 * y te devuelve las 2 cookies (veo_at / veo_rt) que admin-web setea httpOnly, en formato pegable —
 * para inyectar la sesión en chrome-devtools / curl sin pasar por la pantalla de login.
 *
 *   node dev-stack/login.mjs            # imprime cookies + ejemplos (human-friendly)
 *   node dev-stack/login.mjs --json     # imprime {accessToken, refreshToken, cookieHeader} (para pipes)
 *
 * Overridable por env: DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD, DEV_ADMIN_TOTP_SECRET,
 *                      OTP_VIEWER_PORT (default 5190), ADMIN_BFF_URL (default http://localhost:4003).
 */
import { totp } from './lib/totp.mjs';

// ─── Config (todo overridable por env — mismos defaults que otp-viewer/seed) ───────────────────
const EMAIL = process.env.DEV_ADMIN_EMAIL ?? 'admin@veo.pe';
const PASSWORD = process.env.DEV_ADMIN_PASSWORD ?? 'ChangeMe_VEO_2026!';
const TOTP_SECRET = process.env.DEV_ADMIN_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const VIEWER_PORT = Number(process.env.OTP_VIEWER_PORT ?? process.env.PORT ?? 5190);
const VIEWER_URL = `http://localhost:${VIEWER_PORT}/api/otps`;
const BFF_URL = (process.env.ADMIN_BFF_URL ?? 'http://localhost:4003').replace(/\/+$/, '');
const LOGIN_URL = `${BFF_URL}/api/v1/auth/login`;

// Nombres REALES de las cookies de sesión de admin-web (apps/admin-web/src/lib/server/cookies.ts).
const ACCESS_COOKIE = 'veo_at';
const REFRESH_COOKIE = 'veo_rt';

const JSON_MODE = process.argv.slice(2).includes('--json');

/** fetch con timeout (AbortController) — sin deps. */
async function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Sale con un mensaje accionable y exit != 0 (respeta --json: error como JSON en ese modo). */
function fail(message, hint) {
  if (JSON_MODE) {
    console.error(JSON.stringify({ error: message, hint: hint ?? null }));
  } else {
    console.error(`\n  ✗ ${message}`);
    if (hint) console.error(`    → ${hint}`);
  }
  process.exit(1);
}

/**
 * TOTP vivo: preferimos el del otp-viewer (ya calcula sobre el MISMO secreto y refleja el enrolamiento
 * de dev). Si el viewer no responde, fallback a computarlo local con el secreto default. Ambos caminos
 * dan el MISMO código en la misma ventana de 30s (mismo secreto, misma función compartida).
 */
async function getTotp() {
  try {
    const res = await fetchWithTimeout(VIEWER_URL, {}, 3000);
    if (res.ok) {
      const data = await res.json();
      const code = data?.admin?.totp;
      if (typeof code === 'string' && /^\d{6}$/.test(code)) return { code, source: 'otp-viewer' };
    }
  } catch {
    // viewer caído — no es fatal, computamos local abajo
  }
  return { code: totp(TOTP_SECRET), source: 'local (lib/totp.mjs)' };
}

async function main() {
  const { code: totpCode, source } = await getTotp();

  let res;
  try {
    res = await fetchWithTimeout(LOGIN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, totp: totpCode }),
    });
  } catch (err) {
    return fail(
      `no pude conectar con admin-bff en ${LOGIN_URL} (${err?.name === 'AbortError' ? 'timeout' : err?.message ?? err}).`,
      'levantá el stack (veo.sh dev) o exportá ADMIN_BFF_URL si corre en otro host/puerto.',
    );
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const msg =
      body?.error?.message ?? body?.message ?? `HTTP ${res.status}`;
    if (res.status === 401 && /totp/i.test(String(msg))) {
      return fail(
        `admin-bff rechazó el TOTP (${msg}).`,
        `el código pudo rotar entre el cálculo y el POST (usé ${totpCode} de ${source}); reintentá. ` +
          'Si persiste, el secreto de dev no coincide con el enrolado: DEV_ADMIN_TOTP_SECRET debe ser igual a DEV_TOTP_SECRET del seed.',
      );
    }
    return fail(`login falló (HTTP ${res.status}): ${msg}`, 'revisá credenciales (DEV_ADMIN_EMAIL/PASSWORD) o el log de identity-service.');
  }

  // Challenge de enrolamiento: el operador aún no tiene TOTP → no hay tokens todavía.
  if (body?.mustEnrollTotp === true) {
    return fail(
      'el admin de dev NO está enrolado en TOTP (el bff devolvió un challenge de enrolamiento).',
      'corré el seed de identity (que pre-enrola el TOTP dev con el secreto fijo) y reintentá — ' +
        `otpauthUrl del challenge: ${body?.otpauthUrl ?? '(sin url)'}`,
    );
  }

  const accessToken = body?.accessToken;
  const refreshToken = body?.refreshToken;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    return fail(
      'respuesta de login inesperada: no vinieron accessToken/refreshToken.',
      `cuerpo recibido: ${JSON.stringify(body)}`,
    );
  }

  const cookieHeader = `${ACCESS_COOKIE}=${accessToken}; ${REFRESH_COOKIE}=${refreshToken}`;

  if (JSON_MODE) {
    console.log(JSON.stringify({ accessToken, refreshToken, cookieHeader }));
    return;
  }

  // ─── Salida human-friendly, copiable ─────────────────────────────────────────────────────────
  const roles = Array.isArray(body?.admin?.roles) ? body.admin.roles.join(', ') : '?';
  console.log(`\n  ✓ Login OK · ${body?.admin?.email ?? EMAIL} [${roles}] · TOTP de ${source}`);
  console.log('\n  Cookies de sesión (nombres reales de admin-web: veo_at=access, veo_rt=refresh):');
  console.log(`\n    Cookie: ${cookieHeader}`);
  console.log('\n  Ejemplo curl (BFF con Bearer, o admin-web con las cookies):');
  console.log(`    curl -s ${BFF_URL}/api/v1/auth/session -H 'authorization: Bearer ${accessToken}'`);
  console.log(`    curl -s http://localhost:5001/ --cookie '${cookieHeader}'   # admin-web (:5001)`);
  console.log('\n  Ejemplo chrome-devtools (las cookies de admin-web son httpOnly: seteálas por CDP, no por document.cookie):');
  console.log(`    // via evaluate_script no sirve para httpOnly; usá Network.setCookie o el header de arriba.`);
  console.log(`    document.cookie = '${ACCESS_COOKIE}=${accessToken}'; // solo si el contexto NO es httpOnly`);
  console.log('\n  Tokens crudos:');
  console.log(`    access:  ${accessToken}`);
  console.log(`    refresh: ${refreshToken}\n`);
}

main().catch((err) => fail(`error inesperado: ${err?.message ?? err}`));
