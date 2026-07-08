/**
 * Helper E2E para la PALANCA MANUAL del modo de pricing (ADR 023). El modo YA NO vive en un schedule de
 * franjas horarias (ADR 011 superseded · el schedule se BORRÓ de trip-service en Fase A/A2): ahora vive
 * POR OFERTA en el overlay del catálogo (`effectiveOfferingMode`). Hablamos DIRECTO con el endpoint interno
 * del catálogo de trip-service (GET/PUT `/api/v1/internal/catalog`) SIN levantar admin-bff, firmando una
 * identidad admin (HMAC `x-veo-identity`) — un "admin-bff de una línea".
 *
 * trip-service protege esas rutas con InternalIdentityGuard (firma HMAC del header `x-veo-identity` +
 * `x-veo-identity-sig`) y, para el PUT, AdminIdentityGuard (la identidad firmada debe ser `type === 'admin'`).
 *
 * NO mockea dominio: el PUT corre la lógica REAL de CatalogService (persiste el overlay + bump version +
 * emite `catalog.updated` por outbox), y el quote/createTrip resuelven el modo desde ESE catálogo.
 */
import { createHmac } from 'node:crypto';
import { SECRETS, PORTS } from './config.js';

/** Mismos nombres de header que @veo/auth (INTERNAL_IDENTITY_HEADER / _SIG_HEADER). */
const IDENTITY_HEADER = 'x-veo-identity';
const IDENTITY_SIG_HEADER = 'x-veo-identity-sig';

const TRIP_BASE = `http://localhost:${PORTS.trip}/api/v1`;

/** Modo de pricing (espeja PricingMode de @veo/shared-types). */
export type PricingMode = 'PUJA' | 'FIXED';

/** Override de UNA oferta del overlay del catálogo (ADR 013 §1.2 · ADR 023). */
export interface OfferingOverride {
  id: string;
  enabled: boolean;
  mode?: PricingMode;
  multiplier?: number;
  minFareCents?: number;
  baseFareCents?: number;
  perKmCents?: number;
  perMinCents?: number;
}

/** Vista del catálogo EFECTIVO (GET /internal/catalog): ofertas resueltas + overlay crudo + version. */
export interface CatalogView {
  version: number;
  /** Ofertas EFECTIVAS (base ⟕ overlay). Tipamos solo el subconjunto que el helper lee. */
  offerings: { id: string; enabled: boolean; mode: PricingMode }[];
  /** Overlay CRUDO (lo que el admin tiene seteado explícitamente). */
  overrides: OfferingOverride[];
}

/**
 * Firma una identidad interna admin igual que `signInternalIdentity` de @veo/auth:
 * header = base64url(JSON({ ...user, issuedAt })), signature = HMAC-SHA256(header, secret).
 */
function signAdminIdentity(): { header: string; signature: string } {
  const identity = {
    userId: '00000000-0000-0000-0000-0000000000ad',
    type: 'admin' as const,
    roles: ['SUPERADMIN'],
    sessionId: 'e2e-admin-session',
    issuedAt: Date.now(),
  };
  const header = Buffer.from(JSON.stringify(identity)).toString('base64url');
  const signature = createHmac('sha256', SECRETS.internalIdentitySecret)
    .update(header)
    .digest('hex');
  return { header, signature };
}

function adminHeaders(): Record<string, string> {
  const { header, signature } = signAdminIdentity();
  return {
    'content-type': 'application/json',
    [IDENTITY_HEADER]: header,
    [IDENTITY_SIG_HEADER]: signature,
  };
}

/** GET /internal/catalog — el catálogo efectivo (ofertas + overlay crudo + version). */
export async function getCatalog(): Promise<{ status: number; body: CatalogView | undefined }> {
  const res = await fetch(`${TRIP_BASE}/internal/catalog`, {
    method: 'GET',
    headers: adminHeaders(),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (safeJson(text) as CatalogView) : undefined };
}

/**
 * PALANCA MANUAL del modo de UNA oferta (ADR 023 §1.1): PUT /internal/catalog wholesale con el `mode` pineado
 * en la oferta objetivo, PRESERVANDO el resto del overlay (upsert que conserva enabled/precios de las demás y
 * de la propia). Resuelve la version vigente para el CAS (fresh = 0). Lanza si !ok para que el test vea el error.
 */
export async function setOfferingMode(
  offeringId: string,
  mode: PricingMode,
): Promise<{ status: number; body: unknown }> {
  const current = await getCatalog();
  const version = current.body?.version ?? 0;
  const existing = current.body?.overrides ?? [];
  const prev = existing.find((o) => o.id === offeringId);
  const overrides: OfferingOverride[] = [
    ...existing.filter((o) => o.id !== offeringId),
    { ...prev, id: offeringId, enabled: prev?.enabled ?? true, mode },
  ];
  const res = await fetch(`${TRIP_BASE}/internal/catalog`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify({ overrides, expectedVersion: version }),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    throw new Error(
      `PUT /internal/catalog (${offeringId}→${mode}) → ${res.status}: ${
        typeof body === 'string' ? body : JSON.stringify(body)
      }`,
    );
  }
  return { status: res.status, body };
}

/** El modo EFECTIVO de una oferta en el catálogo vigente (aserción AUTORITATIVA del switch). */
export async function offeringMode(offeringId: string): Promise<PricingMode | undefined> {
  const { body } = await getCatalog();
  return body?.offerings.find((o) => o.id === offeringId)?.mode;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
