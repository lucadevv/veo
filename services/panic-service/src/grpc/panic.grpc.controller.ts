/**
 * Controlador gRPC de panic (paquete veo.panic.v1.PanicService).
 * Lectura síncrona del estado de un pánico para otros servicios. Devuelve `found=false` en vez de
 * lanzar, para que el llamante decida (evita ruido de errores cross-servicio).
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PanicService } from '../panic/panic.service';

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
  constructor(private readonly panic: PanicService) {}

  @GrpcMethod('PanicService', 'GetPanic')
  async getPanic({ id }: GetPanicRequest): Promise<PanicReply> {
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
