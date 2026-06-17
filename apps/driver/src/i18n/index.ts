import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import commonEsPe from './locales/es-PE/common.json';

/** Locale base de la app conductor: español de Perú. */
export const APP_LOCALE = 'es-PE';
/** Namespace por defecto de los recursos. */
export const DEFAULT_NS = 'common';

/** Recursos de traducción embebidos (sin red). Un namespace base por ahora. */
export const resources = {
  [APP_LOCALE]: {
    common: commonEsPe,
  },
} as const;

/**
 * Inicializa i18next + react-i18next en es-PE.
 * Importar este módulo (efecto secundario) en el arranque de la app deja `t()` disponible.
 */
i18n.use(initReactI18next).init({
  resources,
  lng: APP_LOCALE,
  fallbackLng: APP_LOCALE,
  ns: [DEFAULT_NS],
  defaultNS: DEFAULT_NS,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
