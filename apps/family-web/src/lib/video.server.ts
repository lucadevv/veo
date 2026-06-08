import { ApiError, HttpClient, familyVideoGrant, type FamilyVideoGrant } from '@veo/api-client';
import { serverEnv } from './env.server';

export { familyVideoGrant, type FamilyVideoGrant };

/**
 * Solicita al bff la autorización de video. Devuelve null si el viaje no la autoriza
 * (403/404), si el bff no responde, o si la respuesta no cumple el contrato.
 */
export async function fetchVideoGrant(token: string): Promise<FamilyVideoGrant | null> {
  const client = new HttpClient({ baseUrl: serverEnv.bffUrl, credentials: 'omit', retries: 0 });
  try {
    return await client.get<FamilyVideoGrant>(
      `/public/share/${encodeURIComponent(token)}/video`,
      { schema: familyVideoGrant },
    );
  } catch (error) {
    if (error instanceof ApiError) return null;
    return null;
  }
}
