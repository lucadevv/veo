import i18n from '../../../i18n';

/**
 * Copy-contract del PERFIL (es-PE, voz VEO). Las claves que consume la pantalla rediseñada y el sheet
 * de verificación de celular DEBEN existir y resolver a texto real (no la clave cruda). Además se
 * fija la VOZ: nada de plantilla genérica ("Identidad verificada / Verificar identidad"); el momento
 * de verificación tiene voz propia. Si alguien borra/renombra una clave que la UI usa, este test
 * falla antes que el dueño lo vea.
 */
const REQUIRED_KEYS = [
  // Cabecera de autor
  'profile.title',
  'profile.addName',
  'profile.editProfile',
  'profile.identityConfirmed',
  // Calificación recibida (protagonista de la cabecera)
  'profile.ratingNone',
  'profile.ratingCountOne',
  'profile.ratingCountMany',
  // Verificación con voz propia (sin verificar)
  'profile.verifyCardTitle',
  'profile.verifyCardBody',
  'profile.verifyCardCta',
  // Franja de completitud (guía, no castigo)
  'profile.completionTitle',
  'profile.completionSubtitle',
  'profile.completionChipName',
  'profile.completionChipPhone',
  'profile.completionChipDocument',
  // Sheet de celular (request + verify)
  'profile.phoneSheetTitle',
  'profile.phoneSheetIntro',
  'profile.phoneFieldLabel',
  'profile.phoneFieldPrefix',
  'profile.phoneInvalid',
  'profile.phoneSendCode',
  'profile.phoneSending',
  'profile.phoneCodeTitle',
  'profile.phoneCodeLabel',
  'profile.phoneVerify',
  'profile.phoneVerifying',
  'profile.phoneCodeInvalid',
  'profile.phoneResend',
  'profile.phoneChangeNumber',
  'profile.phoneAddedTitle',
  'profile.phoneAddedBody',
  'profile.phoneUnavailable',
  // Edición + validaciones con voz
  'profile.editTitle',
  'profile.nameLabel',
  'profile.invalidName',
  'profile.invalidEmail',
  'profile.invalidDocument',
  'profile.documentNote',
  'profile.saveError',
  // CompleteProfileScreen (a la altura): nombre obligatorio; el correo es opcional (con su porqué) o,
  // si ya vino de la cuenta (Apple/Google), una fila de solo lectura con su microcopy. El DOCUMENTO no
  // se pide acá (doctrina de registro mínimo): su momento es al vincular el pago.
  'profileSetup.title',
  'profileSetup.subtitle',
  'profileSetup.emailNote',
  'profileSetup.emailFromAccount',
  'profileSetup.invalidName',
  'profileSetup.submit',
] as const;

describe('Copy-contract · perfil rediseñado + verificación de celular (es-PE)', () => {
  it.each(REQUIRED_KEYS)(
    'resuelve "%s" a texto real (no la clave cruda)',
    key => {
      const value = i18n.t(key);
      expect(typeof value).toBe('string');
      expect(value).not.toBe(key);
      expect(value.length).toBeGreaterThan(0);
    },
  );

  it('interpola el número en el intro del código', () => {
    const value = i18n.t('profile.phoneCodeIntro', {phone: '+51 987654321'});
    expect(value).toContain('987654321');
  });

  it('la verificación NO usa copy de plantilla ("Verificar identidad" / "Identidad verificada")', () => {
    // La voz propia del momento (no la pill genérica del ui-kit), en tuteo peruano.
    expect(i18n.t('profile.verifyCardTitle')).toBe('Confirma que eres tú');
    expect(i18n.t('profile.verifyCardTitle')).not.toContain(
      'Verificar identidad',
    );
    expect(i18n.t('profile.identityConfirmed')).not.toBe(
      'Identidad verificada',
    );
  });

  it('el dato faltante es una invitación, no un misterio: "Agrega tu nombre"', () => {
    expect(i18n.t('profile.addName').toLowerCase()).toContain(
      'agrega tu nombre',
    );
  });

  // El subtítulo dejó de nombrar el dato ("tu nombre") y ahora explica el PORQUÉ del pedido: el
  // conductor confirma a quién recoge (copy actual del CompleteProfileScreen). El test afirma esa
  // intención, no la palabra literal de la versión anterior.
  it('CompleteProfileScreen explica para qué se pide el perfil (el conductor sabe a quién recoge)', () => {
    expect(i18n.t('profileSetup.subtitle').toLowerCase()).toContain('conductor');
  });

  it('el correo de la cuenta se presenta como tomado de tu cuenta (genérico, sin proveedor)', () => {
    expect(i18n.t('profileSetup.emailFromAccount').toLowerCase()).toContain(
      'tu cuenta',
    );
  });

  it('CompleteProfileScreen ya NO tiene copy de documento (doctrina de registro mínimo)', () => {
    // El documento se pide al vincular el pago (YapeLinkSheet/perfil), no en el alta. Si alguien
    // reintroduce claves de documento en `profileSetup`, este test lo frena.
    expect(i18n.t('profileSetup.documentNote')).toBe(
      'profileSetup.documentNote',
    );
    expect(i18n.t('profileSetup.invalidDocument')).toBe(
      'profileSetup.invalidDocument',
    );
  });
});
