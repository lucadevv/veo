/**
 * Controlador gRPC de panic (paquete veo.panic.v1.PanicService).
 * Lectura síncrona del estado de un pánico para otros servicios. Devuelve `found=false` en vez de
 * lanzar, para que el llamante decida (evita ruido de errores cross-servicio).
 */
import { Controller, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity, INTERNAL_IDENTITY_ALLOWED_AUDIENCES, type InternalAudience } from '@veo/auth';
import { PanicService } from '../panic/panic.service';
import type { Env } from '../config/env.schema';

interface GetPanicRequest {
  id: string;
}
interface PanicReply {
  id: string;
  tripId: string;
  passengerId: string;
  status: string;
  geoLat: number;
  geoLon: number;
  triggeredAt: string;
  acknowledgedAt: string;
  ackBy: string;
  found: boolean;
}

const EMPTY: PanicReply = {
  id: '',
  tripId: '',
  passengerId: '',
  status: '',
  geoLat: 0,
  geoLon: 0,
  triggeredAt: '',
  acknowledgedAt: '',
  ackBy: '',
  found: false,
};

@Controller()
export class PanicGrpcController {
  private readonly secret: string;

  constructor(
    private readonly panic: PanicService,
    config: ConfigService<Env, true>,
    @Inject(INTERNAL_IDENTITY_ALLOWED_AUDIENCES)
    private readonly allowedAudiences: readonly InternalAudience[],
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  @GrpcMethod('PanicService', 'GetPanic')
  async getPanic({ id }: GetPanicRequest, metadata: Metadata): Promise<PanicReply> {
    const identity = verifyGrpcIdentity(metadata, this.secret, {
      allowedAudiences: this.allowedAudiences,
    });
    if (!identity) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Identidad interna inválida o ausente',
      });
    }
    const p = await this.panic.getById(id);
    if (!p) return EMPTY;
    return {
      id: p.id,
      tripId: p.tripId,
      passengerId: p.passengerId,
      status: p.status,
      geoLat: p.geoLat,
      geoLon: p.geoLon,
      triggeredAt: p.triggeredAt.toISOString(),
      acknowledgedAt: p.acknowledgedAt ? p.acknowledgedAt.toISOString() : '',
      ackBy: p.ackBy ?? '',
      found: true,
    };
  }
}
