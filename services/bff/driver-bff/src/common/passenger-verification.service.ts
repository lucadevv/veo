/**
 * ADR-018 §1(3) · resolución COMPARTIDA del badge de confianza del pasajero. Vive fuera de un servicio
 * concreto porque lo consume la OFERTA entrante (dispatch.service): la fuente única de verdad del flag
 * es el pasajero, resuelto lazy al SERVIR la oferta (no en la creación del viaje). Antes vivía privado en
 * TripsService (Lote 4); se movió acá al mover el badge a la OFERTA — así una sola implementación resuelve
 * el booleano y no se dispara un GetUser redundante en cada lectura de viaje (getTrip/getActiveTrip).
 */
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import { KycStatus } from '@veo/shared-types';
import { GrpcGateway } from '../infra/grpc.gateway';
import type { UserReply } from './grpc-replies';

@Injectable()
export class PassengerVerificationService {
  constructor(private readonly grpc: GrpcGateway) {}

  /**
   * `true` sii el pasajero está KYC-VERIFIED. Lee identity (GetUser → kycStatus) y devuelve SOLO el
   * booleano — cero PII cruza al conductor. Degradación honesta: si identity no responde (o el usuario no
   * existe), `false` (la oferta se sirve igual, nunca rompe).
   */
  async resolve(passengerId: string, identity: AuthenticatedUser): Promise<boolean> {
    const user = await this.grpc
      .call<UserReply>('identity', 'GetUser', { id: passengerId }, identity)
      .catch(() => null);
    return user?.found === true && user.kycStatus === KycStatus.VERIFIED;
  }
}
