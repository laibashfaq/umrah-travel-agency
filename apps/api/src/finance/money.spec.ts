import { moneyPosition, outstanding, purposeFor, recordPaymentSchema, reportPaymentSchema, verifyPaymentSchema } from '@umrah/shared';

const base = { grandTotal: '300000.00', depositAmount: '75000.00', cancelled: false, received: '0', refunded: '0' };

describe('moneyPosition', () => {
  it('walks from unpaid to paid', () => {
    expect(moneyPosition(base)).toMatchObject({ paymentStatus: 'UNPAID', balanceDue: '300000.00' });
    expect(moneyPosition({ ...base, received: '50000' })).toMatchObject({ paymentStatus: 'PARTIALLY_PAID', balanceDue: '250000.00' });
    expect(moneyPosition({ ...base, received: '75000' })).toMatchObject({ paymentStatus: 'DEPOSIT_PAID', balanceDue: '225000.00' });
    expect(moneyPosition({ ...base, received: '299999.99' })).toMatchObject({ paymentStatus: 'DEPOSIT_PAID', balanceDue: '0.01' });
    expect(moneyPosition({ ...base, received: '300000' })).toMatchObject({ paymentStatus: 'PAID', balanceDue: '0.00' });
  });

  it('counts refunds against what was paid', () => {
    expect(moneyPosition({ ...base, received: '300000', refunded: '100000' })).toMatchObject({ paymentStatus: 'DEPOSIT_PAID', balanceDue: '100000.00', net: '200000.00' });
  });

  it('owes nothing once cancelled, and tracks money still held', () => {
    expect(moneyPosition({ ...base, cancelled: true })).toMatchObject({ paymentStatus: 'UNPAID', balanceDue: '0.00' });
    expect(moneyPosition({ ...base, cancelled: true, received: '75000' })).toMatchObject({ paymentStatus: 'REFUND_PENDING', balanceDue: '0.00' });
    expect(moneyPosition({ ...base, cancelled: true, received: '75000', refunded: '25000' })).toMatchObject({ paymentStatus: 'PARTIALLY_REFUNDED' });
    expect(moneyPosition({ ...base, cancelled: true, received: '75000', refunded: '75000' })).toMatchObject({ paymentStatus: 'REFUNDED', net: '0.00' });
  });

  it('never goes negative when refunds exceed receipts', () => {
    expect(moneyPosition({ ...base, received: '10', refunded: '50' }).net).toBe('0.00');
  });

  it('is exact to the paisa', () => {
    expect(moneyPosition({ ...base, grandTotal: '0.30', depositAmount: '0.10', received: '0.10' })).toMatchObject({ paymentStatus: 'DEPOSIT_PAID', balanceDue: '0.20' });
  });
});

describe('purposeFor and outstanding', () => {
  const b = { grandTotal: '300000.00', depositAmount: '75000.00' };
  it('names what a payment is for', () => {
    expect(purposeFor('300000', { ...b, net: '0.00' })).toBe('FULL');
    expect(purposeFor('75000', { ...b, net: '0.00' })).toBe('DEPOSIT');
    expect(purposeFor('20000', { ...b, net: '0.00' })).toBe('INSTALLMENT');
    expect(purposeFor('100000', { ...b, net: '75000.00' })).toBe('INSTALLMENT');
    expect(purposeFor('225000', { ...b, net: '75000.00' })).toBe('BALANCE');
  });
  it('computes what is left', () => {
    expect(outstanding('300000.00', '75000.00')).toBe('225000.00');
    expect(outstanding('300000.00', '400000.00')).toBe('0.00');
  });
});

describe('payment request validation', () => {
  const ok = { bookingId: '00000000-0000-4000-8000-000000000000', method: 'BANK_TRANSFER', amount: '75000', paidOn: '2026-01-01' };
  it('accepts a normal report and rejects bad amounts, methods and future dates', () => {
    expect(reportPaymentSchema.safeParse(ok).success).toBe(true);
    for (const amount of ['0', '-5', '10.999', 'abc', '']) expect(reportPaymentSchema.safeParse({ ...ok, amount }).success).toBe(false);
    expect(reportPaymentSchema.safeParse({ ...ok, method: 'CARD' }).success).toBe(false); // customers cannot claim a card payment
    expect(recordPaymentSchema.safeParse({ ...ok, method: 'CARD' }).success).toBe(true);
    expect(reportPaymentSchema.safeParse({ ...ok, paidOn: '2999-01-01' }).success).toBe(false);
  });
  it('requires a reason to reject', () => {
    expect(verifyPaymentSchema.safeParse({ decision: 'APPROVE' }).success).toBe(true);
    expect(verifyPaymentSchema.safeParse({ decision: 'REJECT' }).success).toBe(false);
    expect(verifyPaymentSchema.safeParse({ decision: 'REJECT', note: 'No such transfer' }).success).toBe(true);
  });
});
