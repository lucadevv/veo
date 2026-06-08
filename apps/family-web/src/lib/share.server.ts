import { ApiError, HttpClient, familyTrackingView, type FamilyTrackingView } from '@veo/api-client';
import { serverEnv } from './env.server';
import { classifyError, classifyView, type ShareState } from './share-state';

/** Construye un HttpClient contra el public-bff para uso server-side (sin cookies). */
function serverClient(): HttpClient {
  return new HttpClient({ baseUrl: serverEnv.bffUrl, credentials: 'omit', retries: 1 });
}

/**
 * Carga inicial server-side de la vista de seguimiento.
 * GET /public/share/:token → familyTrackingView (validado con zod del contrato compartido).
 * Cualquier fallo se traduce a un estado de pantalla; nunca propaga errores crudos.
 */
export async function fetchShareState(token: string): Promise<ShareState> {
  try {
    const view = await serverClient().get<FamilyTrackingView>(
      `/public/share/${encodeURIComponent(token)}`,
      { schema: familyTrackingView },
    );
    return classifyView(view);
  } catch (error) {
    if (error instanceof ApiError) return classifyError(error.status, error.code);
    // Respuesta con forma inesperada (ZodError) o error de runtime: bff no disponible.
    return { kind: 'unavailable' };
  }
}
