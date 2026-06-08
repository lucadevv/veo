import type { MobilePaymentMethod } from '@veo/api-client';
import { create } from 'zustand';
import { prefsStore } from '../../../../core/storage/mmkv';

/**
 * Preferencia de método de pago por defecto (Zustand + persistencia en prefs).
 *
 * HUECO DE CONTRATO: el public-bff NO expone métodos de pago guardados (solo cobra en
 * `POST /payments/charge`). Los métodos son el enum del contrato (`mobilePaymentMethod`:
 * YAPE/PLIN/CASH/CARD); la SELECCIÓN por defecto es una preferencia local del dispositivo.
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
  setDefault: (method: MobilePaymentMethod) => void;
}

function loadDefault(): MobilePaymentMethod {
  const stored = prefsStore.getString(KEY);
  if (
    stored === 'YAPE' ||
    stored === 'PLIN' ||
    stored === 'CASH' ||
    stored === 'CARD' ||
    stored === 'PAGOEFECTIVO'
  ) {
    return stored;
  }
  return DEFAULT_METHOD;
}

export const usePaymentPrefsStore = create<PaymentPrefsState>((set) => ({
  defaultMethod: loadDefault(),
  setDefault: (method) => {
    prefsStore.setString(KEY, method);
    set({ defaultMethod: method });
  },
}));

/**
 * FUENTE CANÓNICA ÚNICA de métodos de pago (orden de presentación). El enum del wire es
 * `mobilePaymentMethod` (`@veo/api-client`); acá fijamos el ORDEN de presentación de la app. TODA
 * superficie (perfil, al pedir, cambiar método) deriva su lista de acá — cero listas paralelas.
 */
export const PAYMENT_METHODS: readonly MobilePaymentMethod[] = [
  'YAPE',
  'PLIN',
  'CASH',
  'CARD',
  'PAGOEFECTIVO',
];

/**
 * Subset DIGITAL, DERIVADO de la fuente canónica (efectivo fuera). Es la lista para "cambiar método" de
 * un pago pendiente: un cobro digital en curso NO se cambia a efectivo (el conductor ya se fue; el server
 * respondería 422). Antes esto vivía como una SEGUNDA fuente en el wire (`CHANGEABLE_PAYMENT_METHODS =
 * mobileDigitalPaymentMethod.options`); ahora se deriva de `PAYMENT_METHODS` para que haya UNA sola
 * fuente y el orden de presentación sea consistente. El wire (`mobileDigitalPaymentMethod`) sigue siendo
 * la red de seguridad de CONTRATO (el BFF valida y responde 422 ante CASH); esta lista es solo la UI.
 */
export const DIGITAL_PAYMENT_METHODS: readonly MobilePaymentMethod[] = PAYMENT_METHODS.filter(
  (method) => method !== 'CASH',
);
