import type { AdminRole } from '../enums/index.js';

/** Sesión de operador del dashboard (RBAC + step-up MFA, BR-S07). */
export interface AdminSession {
  id: string;
  adminUserId: string;
  roles: AdminRole[];
  ip: string;
  userAgent: string;
  createdAt: Date;
  expiresAt: Date;
  mfaVerifiedAt?: Date;
  revokedAt?: Date;
}
