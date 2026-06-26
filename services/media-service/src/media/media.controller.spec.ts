import { describe, it, expect, vi } from 'vitest';
import { MediaController } from './media.controller';
import type { AccessService } from './access.service';
import type { RecordingService } from './recording.service';
import type { CreateAccessRequestDto } from './dto/media.dto';
import type { AuthenticatedUser } from '@veo/auth';

/**
 * FIX cadena de custodia (BR-S02): el identificador del operador que se QUEMA en el video deriva SIEMPRE de la
 * identidad FIRMADA (`user.email`, fallback `user.userId`), NUNCA de un campo del body forjable. Estos tests
 * fijan ese contrato en el borde HTTP (el controller) — donde antes el email salía de `dto.operatorEmail`.
 */
function makeController(
  requestAccess = vi.fn(async (_input: unknown) => ({ id: 'req-1', status: 'PENDING' as const })),
) {
  const access = { requestAccess } as unknown as AccessService;
  const recording = {} as RecordingService;
  return { controller: new MediaController(recording, access), requestAccess };
}

const baseUser: AuthenticatedUser = {
  userId: 'op-7',
  type: 'admin',
  roles: [],
  sessionId: 's-1',
};

const dto: CreateAccessRequestDto = {
  tripId: '0b5d8f3e-1b2c-4d5e-8f90-1234567890ab',
  reason: 'Investigación formal por queja del pasajero sobre el conductor',
} as CreateAccessRequestDto;

describe('MediaController.requestAccess · identidad firmada > body (BR-S02 · no-repudiación)', () => {
  it('requestedByEmail deriva del email FIRMADO del operador (no del body)', async () => {
    const { controller, requestAccess } = makeController();
    await controller.requestAccess({ ...baseUser, email: 'ana@veo.pe' }, dto);
    expect(requestAccess).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: 'op-7', requestedByEmail: 'ana@veo.pe' }),
    );
  });

  it('fallback al userId FIRMADO cuando el token no porta email (admin re-emitido por refresh)', async () => {
    const { controller, requestAccess } = makeController();
    await controller.requestAccess(baseUser, dto); // sin email
    expect(requestAccess).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: 'op-7', requestedByEmail: 'op-7' }),
    );
  });

  it('un operatorEmail forjado en el body JAMÁS llega al watermark (el controller solo lee user.*)', async () => {
    const { controller, requestAccess } = makeController();
    // Aunque un cliente inyecte el campo crudo (ya no existe en el DTO), el controller nunca lo lee.
    const forged = { ...dto, operatorEmail: 'victima@colega.pe' } as CreateAccessRequestDto & {
      operatorEmail: string;
    };
    await controller.requestAccess({ ...baseUser, email: 'ana@veo.pe' }, forged);
    const arg = requestAccess.mock.calls[0]![0] as unknown as { requestedByEmail: string };
    expect(arg.requestedByEmail).toBe('ana@veo.pe');
    expect(arg.requestedByEmail).not.toBe('victima@colega.pe');
  });
});
