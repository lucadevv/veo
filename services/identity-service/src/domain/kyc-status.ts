/**
 * Eje User.kycStatus — verificación de identidad del usuario (pasajero: liveness OK → VERIFIED;
 * conductor: la aprobación de antecedentes lo arrastra a VERIFIED, ver drivers.service).
 *
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
