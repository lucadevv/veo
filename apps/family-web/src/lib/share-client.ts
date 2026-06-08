import { ApiError, HttpClient, familyTrackingView, type FamilyTrackingView } from '@veo/api-client';
import { publicEnv } from './env';
import { classifyError, classifyView, type ShareState } from './share-state';

/**
 * Revalidación client-side de la vista (React Query).
 * Lanza en estados transitorios (red / 5xx) para que React Query reintente;
 * devuelve un estado terminal (invalid/expired/revoked/ended/active) en los demás casos.
 */
export async function fetchShareStateClient(token: string, signal?: AbortSignal): Promise<ShareState> {
  const client = new HttpClient({ baseUrl: publicEnv.bffUrl, credentials: 'omit', retries: 0 });
  try {
    const view = await client.get<FamilyTrackingView>(
      `/public/share/${encodeURIComponent(token)}`,
      { schema: familyTrackingView, signal },
    );
    return classifyView(view);
  } catch (error) {
    if (error instanceof ApiError) {
      const state = classifyError(error.status, error.code);
      if (state.kind === 'unavailable') throw error;
      return state;
    }
    throw error;
  }
}
