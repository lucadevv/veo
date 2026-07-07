'use client';

import { useToast } from '@/components/ui/toast';
import { runConfigSave } from '@/lib/config-save';

/**
 * Forma estructural mínima de la mutation que el hook consume: `mutateAsync(payload)` + `isPending`. Se tipa
 * así (en vez de `UseMutationResult` completo) para desacoplarse del `TData`/`TError` concreto de cada panel —
 * cada `useReplaceX()` (UseMutationResult<View, Error, Request>) encaja por estructura sin fricción de varianza.
 */
export interface ConfigMutation<TPayload> {
  mutateAsync: (payload: TPayload) => Promise<unknown>;
  isPending: boolean;
}

export interface UseConfigSaveOptions<TPayload> {
  /** La mutation del panel (`useReplaceBaseFare()`, `useReplaceOnDemandRate()`, …). */
  mutation: ConfigMutation<TPayload>;
  /**
   * Título del toast de éxito: estático, o derivado del payload (paneles con éxito dinámico: tarifa base muestra
   * los valores, comisión las tasas, …). Opcional: el catálogo lo pasa por-llamada vía `save(payload, override)`.
   */
  success?: string | ((payload: TPayload) => string);
  /** Sustantivo para el copy canónico del 409. Ej. "la tarifa base", "el costo/km de PE", "el catálogo". */
  conflictNoun: string;
  /** Prefijo del toast de error (sin el message): "No se pudo guardar la tarifa base". El hook le añade ": <message>". */
  error: string;
}

export interface UseConfigSaveResult<TPayload> {
  /**
   * Ejecuta `mutateAsync(payload)` + el toast (success | 409→info | error→danger). `successOverride` pisa el
   * `success` configurado (catálogo). Resuelve a `true` si el write tuvo éxito, `false` si fue 409/error — así
   * un caller con dos writes secuenciales (catálogo + piso de puja) hace short-circuit sin tocar el toast.
   */
  save: (payload: TPayload, successOverride?: string) => Promise<boolean>;
  /** `mutation.isPending` — para deshabilitar el botón Guardar. */
  saving: boolean;
}

/**
 * Mata el ciclo de guardado repetido en los 8 paneles de config (pricing + catálogo): try → `mutateAsync` →
 * toast de éxito; catch → 409 (CAS de optimistic locking) a toast `info` con el copy canónico de conflicto, o
 * cualquier otro error a toast `danger` con el message. NO toca QUÉ se manda ni el `expectedVersion`; la
 * re-sincronización vive en el `onSettled` de la mutation (queries.ts). La lógica vive en `runConfigSave` (puro,
 * testeable); este hook solo inyecta el `toast` del contexto.
 */
export function useConfigSave<TPayload>(
  options: UseConfigSaveOptions<TPayload>,
): UseConfigSaveResult<TPayload> {
  const { toast } = useToast();
  const { mutation, success, conflictNoun, error } = options;

  const save = (payload: TPayload, successOverride?: string): Promise<boolean> => {
    const successTitle =
      successOverride ?? (typeof success === 'function' ? success(payload) : (success ?? ''));
    return runConfigSave({
      mutateAsync: (p: TPayload) => mutation.mutateAsync(p),
      toast,
      payload,
      successTitle,
      conflictNoun,
      errorPrefix: error,
    });
  };

  return { save, saving: mutation.isPending };
}
