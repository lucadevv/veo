import { ApiError } from '@veo/api-client';

/** Tonos del toast (espejo del contrato de `@/components/ui/toast`, que no exporta el tipo). */
export type ConfigSaveTone = 'info' | 'success' | 'danger';

/** Forma mínima del `toast` que el ciclo de guardado necesita (subconjunto del contexto de toast). */
export type ConfigSaveToast = (input: { title: string; tone?: ConfigSaveTone }) => void;

/**
 * Copy CANÓNICO del conflicto optimista (409 · CAS). Estandariza las variantes que tenían los 8 paneles
 * ("los valores vigentes" plural vs "el valor vigente" singular vs "lo vigente", + concordancia la/lo/los del
 * clítico). El sustantivo va DESPUÉS del verbo → no necesita clítico de género/número, así que UN solo texto
 * sirve para todo sustantivo ("la tarifa base", "los precios de energía", "el costo/km de PE", ...).
 */
export function conflictMessage(noun: string): string {
  return `Otro admin cambió ${noun}. Recargamos lo vigente — revisá y reintentá.`;
}

/** Título del toast de error: prefijo del panel + el `message` del Error (paridad con el template repetido). */
export function errorMessage(prefix: string, err: unknown): string {
  return `${prefix}${err instanceof Error ? `: ${err.message}` : ''}`;
}

/**
 * Núcleo PURO del ciclo de guardado de un config (sin React): `mutateAsync` → toast success | 409→info | error→danger.
 * Vive separado del hook para ser testeable en el entorno `node` de vitest (sin DOM ni testing-library); el hook
 * `useConfigSave` es un wrapper fino que inyecta el `toast` del contexto y `mutation.isPending`.
 *
 * Comportamiento IDÉNTICO al try/catch/toast que tenían los paneles:
 *  - éxito → toast `success` con `successTitle`
 *  - 409 (ApiError.status === 409) → toast `info` con el copy canónico de conflicto
 *  - cualquier otro error → toast `danger` con `errorPrefix` + el message
 * NO re-lanza: la re-sincronización (refetch) ya la hace el `onSettled` de la mutation en queries.ts.
 */
export async function runConfigSave<TPayload>(args: {
  mutateAsync: (payload: TPayload) => Promise<unknown>;
  toast: ConfigSaveToast;
  payload: TPayload;
  successTitle: string;
  conflictNoun: string;
  errorPrefix: string;
}): Promise<void> {
  const { mutateAsync, toast, payload, successTitle, conflictNoun, errorPrefix } = args;
  try {
    await mutateAsync(payload);
    toast({ tone: 'success', title: successTitle });
  } catch (err) {
    const conflict = err instanceof ApiError && err.status === 409;
    toast({
      tone: conflict ? 'info' : 'danger',
      title: conflict ? conflictMessage(conflictNoun) : errorMessage(errorPrefix, err),
    });
  }
}
