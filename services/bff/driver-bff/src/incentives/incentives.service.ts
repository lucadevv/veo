/**
 * Incentivos del conductor (lado conductor, Ola 2C). Resuelve el driverId desde la identidad
 * (gRPC GetDriverByUser) y proxya firmado a payment-service (`GET /incentives?driverId=`).
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import type { DriverIncentive } from '@veo/api-client';
import { GrpcGateway } from '../infra/grpc.gateway';
import { RestGateway } from '../infra/rest.gateway';
import type { DriverReply } from '../common/grpc-replies';

@Injectable()
export class IncentivesService {
  constructor(
    private readonly grpc: GrpcGateway,
    private readonly rest: RestGateway,
  ) {}

  async list(identity: AuthenticatedUser): Promise<DriverIncentive[]> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found) throw new ForbiddenException('No existe perfil de conductor para el usuario');
    return this.rest.client('payment').get<DriverIncentive[]>('/incentives', {
      identity,
      query: { driverId: driver.id },
    });
  }
}
