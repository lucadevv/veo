import { mobileRefreshResult } from '@veo/api-client';
import { env } from '../../../core/config/env';
import type { RefreshResult } from '../domain';

/** Timeout del fetch a `/auth/refresh` del relogin biométrico (ms). Evita el spinner eterno si el BFF no responde. */
const RELOGIN_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Llamada remota del refresh biométrico contra el driver-bff (`POST /auth/refresh`). Vive en la capa
 * `data` (regla clean-remote-calls: el `fetch` no va en `presentation`). No usa el `HttpClient` del
 * repositorio a propósito: el relogin necesita un timeout portable propio (AbortController) para fallar
 * rápido y no colgar el spinner con el BFF inalcanzable, y opera sobre el `refreshToken` crudo recién
 * desbloqueado del Keychain, no sobre la sesión en curso.
 *
 * Devuelve los tokens rotados (validados con el schema del contrato). Lanza si el BFF responde no-OK o
 * si la respuesta no matchea el schema — el hook los surfacea como error visible (banner).
 */
export async function refreshBiometricSession(refreshToken: string): Promise<RefreshResult> {
  // Timeout portable (AbortController + setTimeout, mismo patrón que el HttpClient): sin esto, con el BFF
  // inalcanzable el relogin colgaba ~60s (timeout del SO) con el spinner eterno. Falla rápido → cae a OTP.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELOGIN_REFRESH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${env.DRIVER_BFF_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error('No se pudo refrescar la sesión');
  }
  const parsed = mobileRefreshResult.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Respuesta de refresh inválida');
  }
  return parsed.data;
}
