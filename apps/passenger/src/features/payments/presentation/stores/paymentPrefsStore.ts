import type {MobilePaymentMethod} from '@veo/api-client';
import {create} from 'zustand';
import {prefsStore} from '../../../../core/storage/mmkv';

/**
 * Preferencia de método de pago por defecto del pasajero (Zustand + cache MMKV, offline-first).
 *
 * FUENTE DE VERDAD: el backend (identity-service, `User.defaultPaymentMethod`), expuesto en el perfil
 * (`GET/PATCH /users/me`). Al boot, `useProfileCompletion` HIDRATA este store desde el perfil
 * (`hydrate`); al elegir un default, `setDefault` actualiza MMKV (instantáneo, offline) Y empuja el
 * cambio al backend best-effort (`backendSync`, cableado en el composition root). MMKV es el cache que
 * sirve la UI al instante y sobrevive sin red; el backend lo hace sobrevivir reinstalación/multi-dispositivo.
 */
const KEY = 'payments.defaultMethod';
/**
 * Default inicial = YAPE (decisión del dueño: ProntoPaga es el método principal). MIGRACIÓN SUAVE: solo
 * aplica a quien NUNCA eligió un método; quien ya tiene una preferencia guardada en MMKV la conserva
 * (ver `loadDefault`). Antes era 'CASH'.
 */
const DEFAULT_METHOD: MobilePaymentMethod = 'YAPE';

interface PaymentPrefsState {
  defaultMethod: MobilePaymentMethod;
  /** Elige el default (acción del usuario): persiste en MMKV + empuja al backend (best-effort). */
  setDefault: (method: MobilePaymentMethod) => void;
  /** Hidrata desde el backend (perfil) SIN re-empujar: el valor YA viene del backend (evita el echo). */
  hydrate: (method: MobilePaymentMethod) => void;
}

function loadDefault(): MobilePaymentMethod {
  const stored = prefsStore.getString(KEY);
  // PAGOEFECTIVO se retiró del selector (2026-07-14): un CIP es cobro DIFERIDO (se paga en un agente/
  // banco días después) → limbo de "pago pendiente". El enum del wire lo conserva para los pagos
  // HISTÓRICOS y sus webhooks/CIP; acá, un default guardado en PAGOEFECTIVO cae a YAPE.
  if (
    stored === 'YAPE' ||
    stored === 'PLIN' ||
    stored === 'CASH' ||
    stored === 'CARD'
  ) {
    return stored;
  }
  return DEFAULT_METHOD;
}

/**
 * Sincronizador al backend, INYECTADO desde el composition root (registry). El store NO depende de la DI
 * ni de HTTP (DIP): el root le pasa CÓMO persistir al backend. `null` hasta cablearse → sin él `setDefault`
 * solo persiste local (degradación honesta; p.ej. en tests no se dispara red).
 */
let backendSync: ((method: MobilePaymentMethod) => void) | null = null;
export function setPaymentPrefsBackendSync(
  fn: (method: MobilePaymentMethod) => void,
): void {
  backendSync = fn;
}

export const usePaymentPrefsStore = create<PaymentPrefsState>(set => ({
  defaultMethod: loadDefault(),
  setDefault: method => {
    prefsStore.setString(KEY, method);
    set({defaultMethod: method});
    backendSync?.(method);
  },
  hydrate: method => {
    prefsStore.setString(KEY, method);
    set({defaultMethod: method});
  },
}));

/**
 * FUENTE CANÓNICA ÚNICA de métodos de pago (orden de presentación). El enum del wire es
 * `mobilePaymentMethod` (`@veo/api-client`); acá fijamos el ORDEN de presentación de la app. TODA
 * superficie (perfil, al pedir, cambiar método) deriva su lista de acá — cero listas paralelas.
 */
// PAGOEFECTIVO NO está en la lista SELECCIONABLE (2026-07-14, decisión del dueño): el CIP es cobro
// DIFERIDO (pago en agente/banco horas o días después → limbo de "pago pendiente"). El enum del wire
// (`@veo/api-client`) lo conserva para los pagos HISTÓRICOS, sus webhooks y el render del CIP de un
// pendiente ya existente — solo se retira de las superficies de ELECCIÓN de método.
export const PAYMENT_METHODS: readonly MobilePaymentMethod[] = [
  'YAPE',
  'PLIN',
  'CASH',
  'CARD',
];

/**
 * Subset DIGITAL, DERIVADO de la fuente canónica (efectivo fuera). Es la lista para "cambiar método" de
 * un pago pendiente: un cobro digital en curso NO se cambia a efectivo (el conductor ya se fue; el server
 * respondería 422). Antes esto vivía como una SEGUNDA fuente en el wire (`CHANGEABLE_PAYMENT_METHODS =
 * mobileDigitalPaymentMethod.options`); ahora se deriva de `PAYMENT_METHODS` para que haya UNA sola
 * fuente y el orden de presentación sea consistente. El wire (`mobileDigitalPaymentMethod`) sigue siendo
 * la red de seguridad de CONTRATO (el BFF valida y responde 422 ante CASH); esta lista es solo la UI.
 */
export const DIGITAL_PAYMENT_METHODS: readonly MobilePaymentMethod[] =
  PAYMENT_METHODS.filter(method => method !== 'CASH');
