/**
 * Superficie de contratos de admin-web.
 *
 * La FUENTE DE VERDAD es `@veo/api-client` (schemas Zod + tipos del contrato BFF↔web): aquí se
 * re-exporta tal cual para que páginas y queries sigan importando desde '@/lib/api/schemas' sin
 * redefinir nada. admin-web NO define sus propias formas del contrato del bff.
 *
 * Lo único propio de admin-web son los contratos de sus PROPIOS Route Handlers (mismo origen,
 * /api/auth/*), cuyas respuestas no contienen tokens (viven en cookies httpOnly).
 */
import { z } from 'zod';

export * from '@veo/api-client';

/* ── Contratos locales de los Route Handlers de admin-web (NO del bff) ── */

/**
 * Cuerpo aceptado por POST /api/auth/login. `totp` es opcional: los operadores ya enrolados
 * envían email+password+totp en el mismo POST (así lo exige identity-service). Los que aún no
 * enrolaron envían solo email+password y reciben el challenge de enrolamiento.
 */
export const loginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().min(6).max(8).optional(),
});
export type LoginRequest = z.infer<typeof loginRequest>;

/** Datos de enrolamiento TOTP expuestos al navegador para mostrar el QR (sin secretos de sesión). */
export const loginEnrollment = z.object({ otpauthUrl: z.string() });
export type LoginEnrollment = z.infer<typeof loginEnrollment>;

/** Estado que el Route Handler de login devuelve al navegador (los tokens nunca salen del servidor). */
export const loginResult = z.object({
  status: z.enum(['authenticated', 'mfa_required']),
  enrollment: loginEnrollment.nullish(),
});
export type LoginResult = z.infer<typeof loginResult>;
