import i18n from '../../../i18n';

/**
 * Copy-contract: las claves es-PE de la afiliación Yape (pago automático), del método PAGOEFECTIVO y
 * de la rama de checkout del recibo DEBEN existir y resolver a texto real (no devolver la clave cruda).
 * Si alguien borra/renombra una clave que la UI consume, este test falla antes que el dueño lo vea.
 */
const REQUIRED_KEYS = [
  // Pantalla de métodos · patrón instrumentos (UNA línea de experiencia por método)
  'payments.subtitle',
  'payments.defaultPill',
  'payments.line.YAPE',
  'payments.line.PLIN',
  'payments.line.CARD',
  'payments.line.PAGOEFECTIVO',
  'payments.line.CASH',
  // Fila Yape (estados) + sheet de vinculación (la joya)
  'payments.auto.link',
  'payments.auto.linkedLineNoPhone',
  'payments.auto.processLine',
  'payments.auto.linkTitle',
  'payments.auto.linkIntro1',
  'payments.auto.linkIntro2',
  'payments.auto.documentLabel',
  'payments.auto.documentSavedNote',
  'payments.auto.upstreamBusy',
  'payments.auto.docTypeDN',
  'payments.auto.docTypeCE',
  'payments.auto.docTypePP',
  'payments.auto.openYape',
  'payments.auto.waitingTitle',
  'payments.auto.waitingTimeoutTitle',
  'payments.auto.linkedTitle',
  'payments.auto.linkedBody',
  // TASK 1 · al quedar ACTIVE se PREGUNTA si usarlo de predeterminado (no auto-setea)
  'payments.auto.askDefaultTitle',
  'payments.auto.askDefaultBody',
  'payments.auto.askDefaultYes',
  'payments.auto.askDefaultNo',
  'payments.auto.askDefaultDoneTitle',
  'payments.auto.askDefaultDoneBody',
  'payments.auto.askDefaultKeptTitle',
  'payments.auto.askDefaultKeptBody',
  // TASK 2 · selector al pedir (predeterminado visible + recordar) + TASK 4 (léxico Yape)
  'payments.defaultHere',
  'payments.rememberDefault',
  'payments.nameYapeAuto',
  'payments.hintYapeAuto',
  // Sheet de gestión (predeterminado / desvincular)
  'payments.auto.manageTitle',
  'payments.auto.isDefault',
  'payments.auto.makeDefault',
  'payments.auto.unlink',
  'payments.auto.unlinkConfirmTitle',
  'payments.auto.unlinkConfirm',
  // Estados de error/entorno
  'payments.auto.processTitle',
  'payments.auto.expiredTitle',
  'payments.auto.profileIncompleteTitle',
  'payments.auto.profileIncompleteBody',
  'payments.auto.goToProfile',
  'payments.auto.unsupportedTitle',
  'payments.auto.unsupportedBody',
  'payments.auto.error',
  // Método PAGOEFECTIVO + señal "automático"
  'payments.method.PAGOEFECTIVO',
  'payments.hint.PAGOEFECTIVO',
  'payments.autoBadge',
  // Checkout del recibo (ProntoPaga)
  'settlement.checkout.title',
  'settlement.checkout.payWithYape',
  'settlement.checkout.payNow',
  'settlement.checkout.qrInstruction',
  'settlement.checkout.qrAccessibility',
  'settlement.checkout.cipLabel',
  'settlement.checkout.cipInstruction',
  'settlement.checkout.copy',
  'settlement.checkout.cipCopied',
  'settlement.checkout.expiredTitle',
  'settlement.checkout.waitingHint',
] as const;

describe('Copy-contract · afiliación Yape + PAGOEFECTIVO + checkout (es-PE)', () => {
  it.each(REQUIRED_KEYS)('resuelve "%s" a texto real (no la clave cruda)', (key) => {
    const value = i18n.t(key);
    expect(typeof value).toBe('string');
    expect(value).not.toBe(key);
    expect(value.length).toBeGreaterThan(0);
  });

  it('interpola el teléfono enmascarado en la línea del Yape vinculado', () => {
    const value = i18n.t('payments.auto.linkedLine', { phone: '9*****678' });
    expect(value).toContain('9*****678');
  });

  it('interpola la fecha de vencimiento del checkout', () => {
    const value = i18n.t('settlement.checkout.expiresAt', { date: '12/06 14:30' });
    expect(value).toContain('12/06 14:30');
  });

  it('el copy del sheet integra el consentimiento: cobro automático + se desactiva cuando quiera', () => {
    // El consentimiento va INTEGRADO al copy del sheet (2 líneas), no como banner aparte.
    const intro = `${i18n.t('payments.auto.linkIntro1')} ${i18n.t('payments.auto.linkIntro2')}`.toLowerCase();
    expect(intro).toContain('cobra');
    expect(intro).toContain('desactiv');
  });

  it('TASK 1 · el paso post-vínculo PREGUNTA por el predeterminado (no afirma haberlo cambiado)', () => {
    const body = i18n.t('payments.auto.askDefaultBody').toLowerCase();
    expect(body).toContain('predeterminado');
    expect(body).toContain('¿quieres');
  });

  it('TASK 4 · "Yape · automático" (vinculado) ≠ "Yape" (one-shot): el léxico los distingue', () => {
    const auto = i18n.t('payments.nameYapeAuto').toLowerCase();
    const plain = i18n.t('payments.method.YAPE').toLowerCase();
    // El vinculado lleva la palabra "automático"; el one-shot (nombre a secas) NO la lleva.
    expect(auto).toContain('autom');
    expect(plain).not.toContain('autom');
  });

  it('TASK 4 · el RECIBO de un pago one-shot NO dice "automático" (ni paidBody ni el método)', () => {
    // El recibo (SettlementBody·CAPTURED) usa payments.method.* y settlement.paidBody: ninguno menciona
    // "automático". Un cobro pagado una vez con Yape (QR/deepLink) no es el cobro On-File.
    const paid = i18n
      .t('settlement.paidBody', { amount: 'S/ 12.00', method: i18n.t('payments.method.YAPE') })
      .toLowerCase();
    expect(paid).not.toContain('autom');
  });

  it('TASK 4 · el subtítulo one-shot de Yape habla de QR al terminar, no de cobro automático', () => {
    const hint = i18n.t('payments.hint.YAPE').toLowerCase();
    expect(hint).toContain('qr');
    expect(hint).not.toContain('autom');
  });
});
