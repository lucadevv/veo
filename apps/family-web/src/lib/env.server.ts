/**
 * Entorno solo de servidor (no se inlinea al cliente).
 * Importar únicamente desde Server Components / código de servidor.
 * PUBLIC_BFF_URL permite apuntar el fetch server-side a un host interno distinto del público.
 */

const DEFAULT_BFF_URL = 'http://localhost:4001/api/v1';

export const serverEnv = {
  /** Base REST del public-bff usada en el render server-side (Server Components). */
  bffUrl: process.env.PUBLIC_BFF_URL ?? process.env.NEXT_PUBLIC_BFF_URL ?? DEFAULT_BFF_URL,
} as const;
