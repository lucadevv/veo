'use client';

import { HttpClient } from '@veo/api-client';
import { BFF_PROXY_BASE } from '../config';

/**
 * HttpClient del lado cliente apuntando al proxy server-side del mismo origen (/api/bff),
 * con `credentials: include` para que viaje la cookie de sesión. El token Bearer real lo
 * añade el servidor; el navegador nunca lo manipula.
 *
 * HttpClient exige una baseUrl absoluta (usa `new URL`): la componemos con el origen actual.
 */
let client: HttpClient | null = null;

export function apiClient(): HttpClient {
  if (client) return client;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  client = new HttpClient({
    baseUrl: `${origin}${BFF_PROXY_BASE}`,
    credentials: 'include',
    headers: { 'Accept-Language': 'es-PE' },
  });
  return client;
}
