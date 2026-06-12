import { passengerProfile } from '@veo/api-client';

/**
 * Regresión (bug 2026-06-06): `/users/me` devuelve `phone: null` para usuarios que entraron por
 * Apple/Google/correo (no tienen teléfono). El schema DEBE parsear esa forma; si `phone` es
 * `z.string()` no-nullable, `profileQuery` falla y la ProfileScreen muestra "algo salió mal"
 * AUNQUE el backend responda 200. El schema es la fuente de verdad del contrato con el public-bff.
 */
describe('Contrato passengerProfile (@veo/api-client)', () => {
  it('parsea /users/me de un alta por Apple/Google/correo (phone:null)', () => {
    const appleUser = {
      id: '34f1a5d3-8f83-4906-b44a-7708a126f2e8',
      phone: null,
      email: 'user@privaterelay.appleid.com',
      name: 'Juan',
      type: 'PASSENGER',
      kycStatus: 'PENDING',
      photoUrl: null,
      // Documento de identidad para Yape On File de UN TAP: nullable (puede no estar cargado aún).
      documentType: null,
      document: null,
      // Método de pago por defecto (172b34f): el server SIEMPRE manda el campo; null si nunca lo eligió.
      defaultPaymentMethod: null,
      deletionRequestedAt: null,
    };
    expect(passengerProfile.safeParse(appleUser).success).toBe(true);
  });

  it('parsea también un alta por teléfono (phone string, name/email null)', () => {
    const phoneUser = {
      id: 'usr-1',
      phone: '+51987654321',
      email: null,
      name: null,
      type: 'PASSENGER',
      kycStatus: 'VERIFIED',
      photoUrl: null,
      documentType: null,
      document: null,
      defaultPaymentMethod: null,
    };
    expect(passengerProfile.safeParse(phoneUser).success).toBe(true);
  });

  it('parsea un perfil con documento cargado (DNI) para la vinculación de Yape de un toque', () => {
    const withDoc = {
      id: 'usr-2',
      phone: '+51987654321',
      email: null,
      name: 'María Ríos',
      type: 'PASSENGER',
      kycStatus: 'VERIFIED',
      photoUrl: null,
      documentType: 'DN',
      document: '12345678',
      // Con preferencia elegida: debe aceptar cualquier valor del enum de métodos móviles.
      defaultPaymentMethod: 'YAPE',
    };
    expect(passengerProfile.safeParse(withDoc).success).toBe(true);
  });
});
