/**
 * Constantes TIPADAS del gate de elegibilidad del conductor + vigencia del vehículo (ADR-014 §4.1/§8 ·
 * F1a). booking re-valida la elegibilidad server-side contra identity/fleet ANTES de publicar. Estas
 * constantes nombran los valores APROBADOS de cada eje — CERO strings mágicos sueltos en el service.
 *
 * Para los ejes que SÍ tienen enum tipado en @veo/shared-types (DriverStatus, KycStatus,
 * FleetDocumentStatus) se usa ese enum directo. Para los ejes que NO lo tienen (background-check del
 * conductor, status de revisión del vehículo) se define la constante local con el valor REAL verificado
 * en el código fuente del servicio dueño — comentada con su fuente.
 */
import { DriverStatus, KycStatus, FleetDocumentStatus } from '@veo/shared-types';

/**
 * Valor "antecedentes aprobados" del eje Driver.backgroundCheckStatus.
 *
 * FUENTE VERIFICADA: `services/identity-service/src/generated/prisma` enum `BackgroundCheckStatus`
 * (PENDING | CLEARED | REJECTED) — confirmado por `isBackgroundCleared` en
 * `services/identity-service/src/domain/background-check.ts`, que devuelve true SOLO para 'CLEARED'.
 * No existe enum tipado en @veo/shared-types (verificado: BR-I01 vive en identity-service), por eso se
 * fija la constante local con el valor real que identity persiste/emite por el wire (DriverReply.background_check_status).
 */
export const BACKGROUND_CHECK_CLEARED = 'CLEARED' as const;
export type BackgroundCheckCleared = typeof BACKGROUND_CHECK_CLEARED;

/**
 * Valor "vehículo operable" del eje VehicleReply.status (estado de revisión derivado).
 *
 * FUENTE VERIFICADA: `services/fleet-service/src/vehicles/vehicle-rules.ts` const `VehicleReviewStatus`
 * (PENDING_REVIEW | ACTIVE). `deriveVehicleReviewStatus` lo deriva de SEÑALES REALES: docs requeridos del
 * vehículo (SOAT+ITV) presentes+aprobados+vigentes (`hasRequiredVehicleDocsOperable`) Y ficha linkeada
 * (`modelSpecId != null`). Es lo que fleet pone en `VehicleReply.status` (ver `toVehicleReply` en
 * fleet.grpc.controller.ts). No existe enum VehicleStatus tipado en @veo/shared-types (verificado), por eso se
 * fija la constante local. NOTA: en el wire `status==='ACTIVE'` ⟺ `active===true` (fleet deriva AMBOS de la
 * misma señal de operabilidad); el gate exige ambos por defensa en profundidad (ADR-014 §8).
 */
export const VEHICLE_STATUS_OPERABLE = 'ACTIVE' as const;
export type VehicleStatusOperable = typeof VEHICLE_STATUS_OPERABLE;

/**
 * Sub-vista de elegibilidad del conductor (F2 · FIX 1·F2): los CAMPOS AUTORITATIVOS de identity que deciden si
 * un conductor PUEDE operar. Es EXACTAMENTE el conjunto que el gate de publish (`assertDriverEligible`) evalúa,
 * extraído acá como FUENTE ÚNICA y REUSADO en PUBLISH, BÚSQUEDA y DETALLE (public-rail): un conductor pudo ser
 * SUSPENDIDO / KYC-revocado / antecedentes-revocados DESPUÉS de publicar; el gate de publish es one-shot, así que
 * el filtro de búsqueda/detalle debe re-evaluar la elegibilidad COMPLETA sobre el dato fresco de identity.
 *
 * `found` distingue "identity no conoce a este conductor" (no elegible) de un conductor existente pero no apto.
 *
 * INVARIANTE (FIX 1·F2 · ÚNICA fuente de verdad): este shape contiene TODOS los ejes de la decisión — incluido
 * `backgroundCheckStatus`. Toda superficie que evalúe elegibilidad (publish/search/detail) DEBE poder proveerlo:
 * el dato viaja en `DriverReply` (proto identity), que es el origen TANTO de `GetDriver` (publish/detail) COMO de
 * `GetDriversByIds` (search). No hay eje "solo de publish": divergir es imposible por construcción.
 */
export interface DriverEligibilityView {
  /** ¿identity encontró al conductor? false → no elegible (no resolvible). */
  found: boolean;
  /** Estado operativo del conductor (DriverStatus); SUSPENDED → no elegible. */
  currentStatus: string;
  /** ISO-8601 de suspensión; null/"" si NO está suspendido. No-null/no-vacío → no elegible. */
  suspendedAt: string | null;
  /** KYC del conductor (KycStatus); distinto de VERIFIED → no elegible. */
  kycStatus: string;
  /** Revisión de antecedentes (BR-I01); distinto de CLEARED → no elegible. Eje del gate de publish (F1a). */
  backgroundCheckStatus: string;
}

/**
 * Predicado ÚNICO de elegibilidad del conductor (FIX 1·F2 · UNA SOLA FUENTE DE VERDAD para publish/search/detail).
 * Evalúa TODOS los ejes de la decisión booleana "este conductor puede operar":
 *   found===true ∧ suspendedAt vacío/null ∧ currentStatus≠SUSPENDED ∧ kycStatus===VERIFIED ∧ backgroundCheckStatus===CLEARED
 *
 * Es la fuente del juicio para los TRES caminos — `assertDriverEligible` (publish) LO LLAMA en vez de tener su
 * propia lista de condiciones (que podría divergir); el detalle y la búsqueda también. Hacer el predicado más
 * estricto acá (agregar antecedentes) cierra de RAÍZ la asimetría F2: un conductor con antecedentes NO-cleared
 * ya NO pasa el filtro de search/detail (antes sí pasaba, pero NO el de publish → ofertas no-elegibles visibles).
 *
 * CERO strings mágicos: compara contra los enums TIPADOS de @veo/shared-types (DriverStatus.SUSPENDED,
 * KycStatus.VERIFIED) y la constante tipada local BACKGROUND_CHECK_CLEARED (no hay enum en @veo/shared-types).
 */
export function isDriverEligible(driver: DriverEligibilityView): boolean {
  if (!driver.found) return false;
  if (driver.suspendedAt !== null && driver.suspendedAt !== '') return false;
  if (driver.currentStatus === DriverStatus.SUSPENDED) return false;
  if (driver.kycStatus !== KycStatus.VERIFIED) return false;
  if (driver.backgroundCheckStatus !== BACKGROUND_CHECK_CLEARED) return false;
  return true;
}

/**
 * Sub-vista de OPERABILIDAD del vehículo: los ejes de fleet que deciden si el vehículo de una oferta puede
 * seguir operando. Es EXACTAMENTE el conjunto que el gate de publish (`assertVehicleUsable`) evalúa, extraído
 * acá como FUENTE ÚNICA y REUSADO en PUBLISH, DETALLE y RESERVA (la BÚSQUEDA aún NO lo aplica — Lote 3b, ver
 * nota en `isVehicleOperable`): la operabilidad del vehículo es DERIVADA (docs SOAT+ITV reales + ficha linkeada,
 * ver fleet `deriveVehicleReviewStatus`) y por eso FLIPEA — un vehículo cuyos docs VENCEN o son revocados
 * DESPUÉS de publicar deja de ser operable. El gate de publish es one-shot, así que las superficies que
 * ofrecen/comprometen la reserva DEBEN re-evaluar la operabilidad sobre el dato FRESCO de fleet.
 *
 * `found` distingue "fleet no conoce este vehículo" (no operable) de uno existente pero no apto.
 */
export interface VehicleOperabilityView {
  /** ¿fleet encontró el vehículo? false → no operable (no resolvible). */
  found: boolean;
  /** El conductor lo tiene activo (operable). false → no operable. */
  active: boolean;
  /** Estado de revisión derivado (VehicleReply.status); distinto de ACTIVE → no operable. */
  status: string;
  /** Estado documental AGREGADO (VehicleDocStatus de vencimiento); distinto de VALID → no operable. */
  docStatus: string;
}

/**
 * Predicado ÚNICO de operabilidad del vehículo (UNA SOLA FUENTE DE VERDAD para publish/detalle/reserva; la
 * BÚSQUEDA aún no lo aplica — ver nota abajo). Evalúa los ejes de "este vehículo puede operar la oferta":
 *   found===true ∧ active===true ∧ status===ACTIVE ∧ docStatus===VALID
 *
 * Es el MISMO criterio que `assertVehicleUsable` (publish) — ese gate LO LLAMA en vez de tener su propia lista
 * de condiciones (que podría divergir). Hacerlo el predicado compartido cierra de RAÍZ la asimetría: un vehículo
 * cuyos docs vencieron DESPUÉS de publicar ya NO pasa el filtro de detalle/reserva (antes solo lo frenaba el
 * publish, one-shot → ofertas con vehículo no-operable seguían reservables).
 *
 * COBERTURA HONESTA (Lote 3a vs 3b): hoy se aplica en publish (`assertVehicleUsable`), detalle (`getDetail`,
 * fail-closed) y reserva (`assertVehicleOperable`). La BÚSQUEDA (`enrichWithDrivers`) todavía NO filtra por
 * operabilidad del vehículo — requiere un batch `GetVehiclesByIds` en el proto de fleet (anti-N+1), que es el
 * Lote 3b. Mientras tanto una oferta con vehículo no-operable puede aparecer como card en la búsqueda, pero
 * NO es reservable: abrir su detalle da 404 y reservarla da 409 (el hueco de bookability ya está cerrado).
 *
 * CERO strings mágicos: compara contra la constante tipada local VEHICLE_STATUS_OPERABLE (no hay enum
 * VehicleStatus en @veo/shared-types) y el enum TIPADO FleetDocumentStatus.VALID.
 */
export function isVehicleOperable(vehicle: VehicleOperabilityView): boolean {
  if (!vehicle.found) return false;
  if (!vehicle.active) return false;
  if (vehicle.status !== VEHICLE_STATUS_OPERABLE) return false;
  if (vehicle.docStatus !== FleetDocumentStatus.VALID) return false;
  return true;
}

/**
 * Sub-vista MÍNIMA del gate de APROBAR/RECHAZAR una solicitud (F3b · ADR-014 §8): solo los ejes de
 * "el conductor sigue ACTIVO / no suspendido". DELIBERADAMENTE más laxo que `isDriverEligible` (publish):
 * al APROBAR, el conductor YA pasó el gate FULL de publish (KYC/antecedentes one-shot al publicar su oferta);
 * lo que F3b re-valida es que NO haya sido SUSPENDIDO entre publicar y aprobar — un conductor suspendido no
 * puede seguir operando sobre sus ofertas vivas. No re-pedimos KYC/antecedentes acá porque (a) ya se validaron
 * al publicar y (b) el riesgo es de SUSPENSIÓN sobreviniente, no de un alta no verificada.
 */
export interface DriverActiveView {
  /** ¿identity encontró al conductor? false → no activo (no resolvible). */
  found: boolean;
  /** Estado operativo del conductor (DriverStatus); SUSPENDED → no activo. */
  currentStatus: string;
  /** ISO-8601 de suspensión; null/"" si NO está suspendido. No-null/no-vacío → no activo. */
  suspendedAt: string | null;
}

/**
 * Predicado del gate de APROBAR/RECHAZAR (F3b): el conductor está ACTIVO si fue encontrado, NO está
 * suspendido (ni por timestamp ni por estado). Predicado ENFOCADO en suspensión sobreviniente — ver
 * `DriverActiveView` para el porqué de no re-validar KYC/antecedentes acá. CERO strings mágicos: compara
 * contra el enum TIPADO DriverStatus.SUSPENDED.
 */
export function isDriverActive(driver: DriverActiveView): boolean {
  if (!driver.found) return false;
  if (driver.suspendedAt !== null && driver.suspendedAt !== '') return false;
  if (driver.currentStatus === DriverStatus.SUSPENDED) return false;
  return true;
}
