/**
 * Webhook entrante de ProntoPaga: POST /webhooks/prontopaga.
 *
 * SEGURIDAD máxima:
 *  - @Public: no exige identidad interna (el proveedor no la tiene). La AUTENTICIDAD la da la FIRMA.
 *  - rawBody preservado (main.ts `rawBody: true`): la firma se verifica sobre los BYTES EXACTOS recibidos.
 *  - Firma inválida → 401 + log WARN con traceId, SIN detalles del cuerpo.
 *  - Procesamiento IDEMPOTENTE y CORTO: status-guards en el servicio; siempre 200 rápido tras procesar.
 *
 * Nada de lógica lenta inline: capturar/transicionar es una escritura corta + un evento outbox.
 */
import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '@veo/auth';
import { UnauthorizedError } from '@veo/utils';
import { ProntoPagaWebhookService } from './prontopaga-webhook.service';

interface RawBodyRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

@ApiTags('webhooks')
@Controller('webhooks/prontopaga')
export class ProntoPagaWebhookController {
  private readonly logger = new Logger(ProntoPagaWebhookController.name);

  constructor(private readonly service: ProntoPagaWebhookService) {}

  @Public()
  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Webhook de ProntoPaga (firma HMAC verificada). Idempotente. Pago o afiliación.',
  })
  async handle(@Req() req: RawBodyRequest): Promise<{ ok: true }> {
    // El raw body es la fuente de verdad para la firma. Sin él no podemos verificar → 401.
    const raw = req.rawBody?.toString('utf8');
    if (!raw) {
      this.logger.warn('Webhook ProntoPaga sin rawBody; rechazado');
      throw new UnauthorizedError('Webhook sin cuerpo verificable');
    }
    // verifyWebhook lanza UnauthorizedError (→401) si la firma es inválida. NO logueamos el cuerpo.
    await this.service.process(raw, req.headers);
    return { ok: true };
  }

  // ── Callback de REEMBOLSO (S5): ruta DEDICADA que ProntoPaga recibe como urlCallbackRefund. La ruta
  // clasifica el evento como reverso (el payload no trae marcador de tipo confiable); misma firma HMAC
  // y mismo trato idempotente que el webhook principal.
  // CONTRATO DE RESPUESTA (playbook): 200 SOLO cuando pudimos correlacionar/persistir el desenlace.
  // Un callback cuyo uid todavía no matchea un Refund (carrera: llegó antes de que refundViaGateway
  // persistiera el uid del reverso) propaga NotFoundError → 404: el proveedor REINTENTA la entrega
  // (igual que ante el 401 de firma inválida) y en el retry la correlación ya existe. Absorberlo con
  // 200 dejaría el Refund PENDING para siempre (el proveedor no reintenta lo que cree entregado). ──
  @Public()
  @Post('refund')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Callback de reembolso de ProntoPaga (urlCallbackRefund). Firma HMAC verificada. Idempotente. ' +
      '404 si el reverso aún no correlaciona (el proveedor reintenta).',
  })
  async handleRefund(@Req() req: RawBodyRequest): Promise<{ ok: true }> {
    const raw = req.rawBody?.toString('utf8');
    if (!raw) {
      this.logger.warn('Callback de reembolso ProntoPaga sin rawBody; rechazado');
      throw new UnauthorizedError('Webhook sin cuerpo verificable');
    }
    await this.service.processRefund(raw, req.headers);
    return { ok: true };
  }
}
