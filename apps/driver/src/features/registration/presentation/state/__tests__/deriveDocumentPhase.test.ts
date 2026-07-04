import { deriveDocumentPhase, type DocumentFacePhases } from '../registrationStore';

/**
 * Pruebas del helper PURO `deriveDocumentPhase` (Lote 1): DERIVA la fase de un DOCUMENTO a partir de las
 * fases de sus caras (anverso/reverso). Regla (exhaustiva, sin strings mágicos):
 *  1. `error` si ALGUNA cara está en `error`.
 *  2. si no, `sending` si ALGUNA está en `sending`.
 *  3. si no, `sent` si TODAS las caras NO-`idle` están `sent` Y hay ≥1 `sent` (doc de 1 cara: back `idle`
 *     "no aplica", así front `sent` ⇒ documento `sent`).
 *  4. si no, `idle`.
 */
const faces = (front: DocumentFacePhases['front'], back: DocumentFacePhases['back']): DocumentFacePhases => ({
  front,
  back,
});

describe('deriveDocumentPhase', () => {
  it('documento de UNA cara (front sent, back idle) ⇒ sent (el idle "no aplica")', () => {
    expect(deriveDocumentPhase(faces('sent', 'idle'))).toBe('sent');
  });

  it('documento de DOS caras (ambas sent) ⇒ sent', () => {
    expect(deriveDocumentPhase(faces('sent', 'sent'))).toBe('sent');
  });

  it('una cara en error (aunque la otra esté sent) ⇒ error (una cara rota = documento falló)', () => {
    expect(deriveDocumentPhase(faces('sent', 'error'))).toBe('error');
    expect(deriveDocumentPhase(faces('error', 'idle'))).toBe('error');
  });

  it('una cara sending (sin errores) ⇒ sending', () => {
    expect(deriveDocumentPhase(faces('sending', 'idle'))).toBe('sending');
    expect(deriveDocumentPhase(faces('sent', 'sending'))).toBe('sending');
  });

  it('error gana sobre sending (una cara error + otra sending ⇒ error)', () => {
    expect(deriveDocumentPhase(faces('error', 'sending'))).toBe('error');
  });

  it('ambas caras idle ⇒ idle (nada empezó)', () => {
    expect(deriveDocumentPhase(faces('idle', 'idle'))).toBe('idle');
  });

  it('front idle + back sent ⇒ sent (la única cara no-idle está sent)', () => {
    // Robusto ante el orden: da igual qué cara sea la que subió; si la no-idle está sent, el doc está sent.
    expect(deriveDocumentPhase(faces('idle', 'sent'))).toBe('sent');
  });
});
