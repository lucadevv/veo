import i18n from '../../../i18n';

/**
 * Copy-contract del DebtSheet + franja del home (gate de deuda BR-P02). Las claves es-PE que la UI de
 * deuda consume DEBEN existir y resolver a texto real (no la clave cruda). Si alguien borra/renombra una
 * clave que el sheet o la franja usan, este test falla antes que el dueño lo vea. El tono peruano (tuteo)
 * lo vigila aparte el `voseoGuard.test`; acá garantizamos PRESENCIA y la interpolación del monto/fecha.
 */
const REQUIRED_KEYS = [
  // Resumen de la deuda
  'debt.title',
  'debt.reason',
  'debt.amountLabel',
  'debt.itemsTitle',
  'debt.itemLabel',
  // CTA + escape
  'debt.payNow',
  'debt.paying',
  'debt.notNow',
  // Éxito (saldó directo o tras checkout)
  'debt.settledTitle',
  'debt.settledBody',
  'debt.settledClose',
  // Rama de checkout dentro del sheet
  'debt.checkoutTitle',
  'debt.checkoutBody',
  // Errores honestos
  'debt.retryFailedTitle',
  'debt.retryFailedBody',
  'debt.error',
  // Franja pasiva del home · DEUDA
  'debt.homeBannerTitle',
  'debt.homeBannerAction',
  // Franja pasiva del home + sheet · PAGO POR COMPLETAR (PENDING_ACTION)
  'debt.homePendingTitle',
  'debt.homePendingAction',
  'debt.continueSheetTitle',
  'debt.continueTitle',
  'debt.continueBody',
  'debt.completedBody',
  'debt.pendingGoneTitle',
  'debt.pendingGoneBody',
  // TASK 3 · cambiar el método de un pago pendiente (encabezado honesto + selector digital + errores)
  'debt.pendingPaymentLabel',
  'debt.currentMethod',
  'debt.changeMethodCta',
  'debt.changeMethodTitle',
  'debt.changeMethodSubtitle',
  'debt.changingMethod',
  'debt.changeMethodNotApplicableTitle',
  'debt.changeMethodNotApplicableBody',
  'debt.changeMethodGoneTitle',
  'debt.changeMethodGoneBody',
  'debt.changeMethodError',
  // El sheet reusa el render de checkout del recibo (medios): esas claves DEBEN seguir existiendo.
  'settlement.checkout.payWithYape',
  'settlement.checkout.payNow',
  'settlement.checkout.qrInstruction',
  'settlement.checkout.cipLabel',
  'settlement.checkout.copy',
  'settlement.checkout.expiredTitle',
  'settlement.checkout.waitingHint',
  // Fallback honesto cuando openURL rechaza (Yape no instalada / esquema desconocido) + fallback web.
  'settlement.checkout.openYapeFailedTitle',
  'settlement.checkout.openYapeFailedBody',
  'settlement.checkout.openYapeFailedBodyNoWeb',
  'settlement.checkout.payInBrowser',
  'settlement.checkout.openWebFailedTitle',
  'settlement.checkout.openWebFailedBody',
  // Afiliación Yape: aviso si no se pudo abrir Yape.
  'payments.auto.openFailedTitle',
  'payments.auto.openFailedBody',
] as const;

describe('Copy-contract · DebtSheet + franja de deuda (es-PE)', () => {
  it.each(REQUIRED_KEYS)('resuelve "%s" a texto real (no la clave cruda)', (key) => {
    const value = i18n.t(key);
    expect(typeof value).toBe('string');
    expect(value).not.toBe(key);
    expect(value.length).toBeGreaterThan(0);
  });

  it('el título es honesto y NO alarmante: "pago pendiente", no "deuda/moroso"', () => {
    const title = i18n.t('debt.title').toLowerCase();
    expect(title).toContain('pendiente');
    expect(title).not.toContain('moroso');
    expect(title).not.toContain('deuda');
  });

  it('la razón explica el porqué sin culpar (un cobro anterior no se pudo completar)', () => {
    const reason = i18n.t('debt.reason').toLowerCase();
    expect(reason).toContain('cobro');
    expect(reason).toContain('anterior');
  });

  it('el éxito invita a volver a pedir el viaje', () => {
    const body = i18n.t('debt.settledBody').toLowerCase();
    expect(body).toContain('pedir');
  });

  it('interpola la fecha del viaje en la fila de la lista de deudas', () => {
    const value = i18n.t('debt.itemLabel', { date: '03/06 12:00' });
    expect(value).toContain('03/06 12:00');
  });

  it('TASK 3 · el encabezado del pago pendiente interpola el método actual', () => {
    const value = i18n.t('debt.currentMethod', { method: 'Yape' });
    expect(value).toContain('Yape');
  });

  it('TASK 3 · el subtítulo del selector de cambio aclara que el efectivo no aplica', () => {
    const value = i18n.t('debt.changeMethodSubtitle').toLowerCase();
    expect(value).toContain('efectivo');
  });
});
