/**
 * Eje User.kycStatus — verificación de IDENTIDAD del usuario, DESACOPLADA de la aprobación operativa:
 *  - pasajero: liveness OK → VERIFIED (kyc.service).
 *  - conductor: la verificación de identidad la CONFIRMA el OPERADOR humano al aprobar (approve() setea
 *    kycStatus→VERIFIED + kycVerifiedAt, en el MISMO acto que el CLEARED). Los face-match (rostro↔DNI/licencia)
 *    y el liveness PASIVO solo PERSISTEN su binding — NO auto-verifican el KYC (decisión del dueño: la
 *    verificación de identidad es un acto humano, no automático). La aprobación es el eje SEPARADO
 *    `backgroundCheckStatus` (CLEARED en approve()); la elegibilidad operativa exige AMBOS.
 *
 *  - UNVERIFIED → VERIFIED | REJECTED: ESTADO INICIAL (ADR-018) — un usuario recién onboardeado no
 *    arrancó ningún KYC. El pasajero pasa el liveness OPCIONAL → VERIFIED (badge de confianza, NO muro
 *    pre-viaje); el conductor pasa el binding biométrico → VERIFIED. Un intento fallido → REJECTED. NO
 *    va a PENDING: PENDING queda para un futuro verify asíncrono (hoy inexistente); nadie NACE ahí ni
 *    "reenvía a revisión" sin haber sido rechazado antes (resubmit es SOLO REJECTED→PENDING).
 *  - PENDING → VERIFIED | REJECTED: resultado de la verificación (biométrica u operador).
 *  - VERIFIED → EXPIRED | REJECTED: la verificación caduca o se revoca.
 *  - REJECTED → VERIFIED: re-verificación exitosa (el rechazo NO es terminal: el pasajero puede
 *    reintentar el liveness y el operador puede re-aprobar al conductor).
 *  - REJECTED → PENDING: el conductor RECHAZADO corrige y REENVÍA a revisión (resubmit) — su KYC vuelve
 *    a la cola de decisión junto con sus antecedentes. Sin esto el rechazo era un dead-end.
 *  - EXPIRED → VERIFIED | REJECTED: re-verificación tras caducar.
 * Prohibido: volver a PENDING desde VERIFIED/EXPIRED (una verificación vigente/caduca no "des-decide" sola).
 */
import { KycStatus } from '../generated/prisma';
import { createStateMachine, type StateMachine } from './state-machine';

/** Tabla de transiciones válidas del KYC. */
export const KYC_STATUS_TRANSITIONS: Readonly<Record<KycStatus, readonly KycStatus[]>> = {
  [KycStatus.UNVERIFIED]: [KycStatus.VERIFIED, KycStatus.REJECTED],
  [KycStatus.PENDING]: [KycStatus.VERIFIED, KycStatus.REJECTED],
  [KycStatus.VERIFIED]: [KycStatus.EXPIRED, KycStatus.REJECTED],
  [KycStatus.REJECTED]: [KycStatus.VERIFIED, KycStatus.PENDING],
  [KycStatus.EXPIRED]: [KycStatus.VERIFIED, KycStatus.REJECTED],
};

/** Máquina del eje User.kycStatus. */
export const kycStatusMachine: StateMachine<KycStatus> = createStateMachine(
  'KYC',
  KYC_STATUS_TRANSITIONS,
);
