import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { defaultNS, resources } from './resources';

/**
 * Inicialización de i18n (i18next + react-i18next) en es-PE.
 * Importar este módulo por su efecto secundario antes de renderizar la app.
 */
void i18n.use(initReactI18next).init({
  resources,
  lng: 'es-PE',
  fallbackLng: 'es-PE',
  defaultNS,
  ns: ['common'],
  interpolation: {
    // RN no necesita el escape de HTML que hace i18next para web.
    escapeValue: false,
  },
  // Evita depender de Intl.PluralRules en Hermes (no usamos plurales todavía).
  compatibilityJSON: 'v3',
  returnNull: false,
});

export { defaultNS, resources } from './resources';
export default i18n;
