import {common} from './locales/es-PE/common';

/** Namespace por defecto de la app. */
export const defaultNS = 'common';

/** Recursos agrupados por idioma → namespace. */
export const resources = {
  'es-PE': {
    common,
  },
} as const;

export type AppResources = (typeof resources)['es-PE'];
