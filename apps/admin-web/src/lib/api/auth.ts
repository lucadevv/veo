'use client';

import { loginResult, type LoginResult } from './schemas';

/**
 * Llamadas de autenticación del cliente. Pegan a los Route Handlers del MISMO origen
 * (/api/auth/*), que son quienes hablan con el admin-bff y gestionan las cookies httpOnly.
 * El cliente NUNCA ve access/refresh tokens.
 */

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
}

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return data?.error?.message ?? `Error ${res.status}`;
}

/**
 * Inicia sesión. `totp` es opcional: los operadores ya enrolados lo envían junto a sus credenciales
 * (identity exige email+password+totp en el mismo POST). Los no enrolados lo omiten y reciben el
 * challenge de enrolamiento (status 'mfa_required' con la URL otpauth).
 */
export async function login(email: string, password: string, totp?: string): Promise<LoginResult> {
  const res = await postJson(
    '/api/auth/login',
    totp ? { email, password, totp } : { email, password },
  );
  if (!res.ok) throw new Error(await readError(res));
  return loginResult.parse(await res.json());
}

/** Confirma el primer enrolamiento TOTP reenviando credenciales + el código generado. */
export async function confirmTotp(email: string, password: string, code: string): Promise<void> {
  const res = await postJson('/api/auth/totp/confirm', { email, password, code });
  if (!res.ok) throw new Error(await readError(res));
}

export async function stepUp(code: string): Promise<void> {
  const res = await postJson('/api/auth/step-up', { code });
  if (!res.ok) throw new Error(await readError(res));
}

export async function logout(): Promise<void> {
  await postJson('/api/auth/logout', {});
}

/**
 * Cierra la sesión en TODOS los dispositivos (revoca todas las sesiones + sella el denylist epoch en identity,
 * ADR-012 §2). El Route Handler adjunta el refresh token de la cookie httpOnly; el navegador nunca lo ve.
 */
export async function logoutAll(): Promise<void> {
  await postJson('/api/auth/logout-all', {});
}
