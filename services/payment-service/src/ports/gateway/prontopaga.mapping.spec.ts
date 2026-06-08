import { describe, it, expect } from 'vitest';
import {
  mapMethodToProntoPaga,
  mapProntoPagaStatus,
  mapAffiliationStatus,
  normalizeWebhook,
  originForMethod,
} from './prontopaga.mapping';

describe('mapMethodToProntoPaga · NUESTRO método → método ProntoPaga', () => {
  it('YAPE con walletUid (afiliación activa) → yape_cof_payment (on-file)', () => {
    expect(mapMethodToProntoPaga('YAPE', true)).toBe('yape_cof_payment');
  });
  it('YAPE sin walletUid → yape_oneshot_payment (deepLink; el sandbox público NO habilita pe_qr_3)', () => {
    expect(mapMethodToProntoPaga('YAPE', false)).toBe('yape_oneshot_payment');
  });
  it('PLIN → pe_qr_3_payment', () => {
    expect(mapMethodToProntoPaga('PLIN', false)).toBe('pe_qr_3_payment');
  });
  it('originForMethod: yape_oneshot exige mobile (minúscula); el resto undefined', () => {
    expect(originForMethod('yape_oneshot_payment')).toBe('mobile');
    expect(originForMethod('pe_card_payment')).toBeUndefined();
    expect(originForMethod('pe_qr_3_payment')).toBeUndefined();
    expect(originForMethod('yape_cof_payment')).toBeUndefined();
  });
  it('CARD → pe_card_payment', () => {
    expect(mapMethodToProntoPaga('CARD', false)).toBe('pe_card_payment');
  });
  it('PAGOEFECTIVO → pagoefectivo_payment', () => {
    expect(mapMethodToProntoPaga('PAGOEFECTIVO', false)).toBe('pagoefectivo_payment');
  });
});

describe('mapProntoPagaStatus · estado de pago (docs/payins-status)', () => {
  it('success → CONFIRMED', () => expect(mapProntoPagaStatus('success')).toBe('CONFIRMED'));
  it('rejected → DECLINED', () => expect(mapProntoPagaStatus('rejected')).toBe('DECLINED'));
  it('canceled → DECLINED', () => expect(mapProntoPagaStatus('canceled')).toBe('DECLINED'));
  it('expired → EXPIRED', () => expect(mapProntoPagaStatus('expired')).toBe('EXPIRED'));
  it('pending → PENDING', () => expect(mapProntoPagaStatus('pending')).toBe('PENDING'));
  it('new/created → PENDING', () => {
    expect(mapProntoPagaStatus('new')).toBe('PENDING');
    expect(mapProntoPagaStatus('created')).toBe('PENDING');
  });
  it('es case-insensitive', () => expect(mapProntoPagaStatus('SUCCESS')).toBe('CONFIRMED'));
});

describe('mapAffiliationStatus', () => {
  it('ACTIVE → CONFIRMED', () => expect(mapAffiliationStatus('ACTIVE')).toBe('CONFIRMED'));
  it('EXPIRED → EXPIRED', () => expect(mapAffiliationStatus('EXPIRED')).toBe('EXPIRED'));
  it('PROCESS → PENDING', () => expect(mapAffiliationStatus('PROCESS')).toBe('PENDING'));
});

describe('normalizeWebhook · body ProntoPaga → WebhookResult', () => {
  it('clasifica un pago (sin wallet_uid) y mapea estado', () => {
    const r = normalizeWebhook({ uid: 'tx-1', order: 'pay-1', status: 'success', amount: 25.5 });
    expect(r.kind).toBe('payment');
    expect(r.externalId).toBe('tx-1');
    expect(r.order).toBe('pay-1');
    expect(r.status).toBe('CONFIRMED');
  });

  it('clasifica una afiliación cuando trae wallet_uid y NO trae order de pago', () => {
    const r = normalizeWebhook({ uid: 'aff-uid-1', wallet_uid: 'WUID-123', status: 'ACTIVE' });
    expect(r.kind).toBe('affiliation');
    expect(r.status).toBe('CONFIRMED');
  });

  it('un cobro ON-FILE rechazado por saldo (wallet_uid + order + YPTRX002) es PAGO, no afiliación', () => {
    const r = normalizeWebhook({
      uid: 'tx-9',
      order: 'pay-9',
      wallet_uid: 'WUID-123',
      status: 'rejected',
      error_code: 'YPTRX002',
    });
    expect(r.kind).toBe('payment'); // tiene order ⇒ es un cobro, no una afiliación
    expect(r.status).toBe('DECLINED');
    expect(r.order).toBe('pay-9');
    expect(r.errorCode).toBe('YPTRX002');
  });

  it('cae a reference cuando no hay uid', () => {
    const r = normalizeWebhook({ reference: 'ref-9', status: 'pending' });
    expect(r.externalId).toBe('ref-9');
    expect(r.status).toBe('PENDING');
  });
});
