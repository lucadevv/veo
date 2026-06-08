import 'react-i18next';
import type { defaultNS, resources } from './resources';

/**
 * Tipado de las claves de traducción: `t('screens.home')` queda autocompletado y
 * verificado en compilación (sin `any`).
 */
declare module 'react-i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: (typeof resources)['es-PE'];
  }
}
