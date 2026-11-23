import { ageOn, computeQuote, passportValidUntilOk, roomRequestError, travelerKindFor, type PriceTable } from '@umrah/shared';

const prices: PriceTable = {
  DOUBLE: { adult: '100000.50', child: '80000.25', infant: '10000.00' },
  QUAD: { adult: '90000.00', child: null, infant: null },
};
const percent = { type: 'PERCENTAGE', value: '25' } as const;

describe('computeQuote', () => {
  it('sums rooms exactly in minor units', () => {
    const r = computeQuote([{ occupancy: 'DOUBLE', adults: 1, children: 1, infants: 1 }], prices, percent);
    expect(r.ok && r.quote.grandTotal).toBe('190000.75'); // 100000.50 + 80000.25 + 10000.00
    expect(r.ok && r.quote.depositAmount).toBe('47500.19'); // 25% rounded up to the paisa
    expect(r.ok && r.quote.seats).toBe(2); // infants do not take a seat
  });

  it('falls back to the adult fare for children and is free for infants without a fare', () => {
    const r = computeQuote([{ occupancy: 'QUAD', adults: 1, children: 2, infants: 1 }], prices, percent);
    expect(r.ok && r.quote.grandTotal).toBe('270000.00');
  });

  it('supports the other deposit rules and never exceeds the total', () => {
    const rooms = [{ occupancy: 'QUAD', adults: 2, children: 0, infants: 0 }] as const;
    const perPerson = computeQuote([...rooms], prices, { type: 'FIXED_PER_PERSON', value: '20000' });
    expect(perPerson.ok && perPerson.quote.depositAmount).toBe('40000.00');
    const perBooking = computeQuote([...rooms], prices, { type: 'FIXED_PER_BOOKING', value: '999999999' });
    expect(perBooking.ok && perBooking.quote.depositAmount).toBe('180000.00');
  });

  it('rejects impossible room plans', () => {
    expect(computeQuote([], prices, percent)).toMatchObject({ ok: false, error: { code: 'no_rooms' } });
    expect(computeQuote([{ occupancy: 'DOUBLE', adults: 3, children: 0, infants: 0 }], prices, percent)).toMatchObject({ ok: false, error: { code: 'room_over_capacity' } });
    expect(computeQuote([{ occupancy: 'DOUBLE', adults: 0, children: 2, infants: 0 }], prices, percent)).toMatchObject({ ok: false, error: { code: 'room_needs_adult' } });
    expect(computeQuote([{ occupancy: 'TRIPLE', adults: 1, children: 0, infants: 0 }], prices, percent)).toMatchObject({ ok: false, error: { code: 'no_price' } });
    const many = Array.from({ length: 16 }, () => ({ occupancy: 'DOUBLE' as const, adults: 2, children: 0, infants: 0 }));
    expect(computeQuote(many, prices, percent)).toMatchObject({ ok: false, error: { code: 'too_many_travelers' } });
    expect(roomRequestError({ occupancy: 'QUAD', adults: 2, children: 2, infants: 3 }, 0)).toBeNull();
  });
});

describe('traveler age rules', () => {
  it('counts completed years', () => {
    expect(ageOn('2000-06-15', '2026-06-14')).toBe(25);
    expect(ageOn('2000-06-15', '2026-06-15')).toBe(26);
  });

  it('classifies infant, child and adult on the return date', () => {
    expect(travelerKindFor('2025-01-10', '2026-12-01')).toBe('INFANT'); // 1 year
    expect(travelerKindFor('2024-11-30', '2026-12-01')).toBe('CHILD'); // 2 years
    expect(travelerKindFor('2015-12-02', '2026-12-01')).toBe('CHILD'); // 10 years
    expect(travelerKindFor('2014-12-01', '2026-12-01')).toBe('ADULT'); // 12 years
    expect(travelerKindFor('1980-01-01', '2026-12-01')).toBe('ADULT');
  });
});

describe('passport validity', () => {
  it('needs six months after the return date', () => {
    expect(passportValidUntilOk('2027-06-01', '2026-12-01')).toBe(true);
    expect(passportValidUntilOk('2027-05-31', '2026-12-01')).toBe(false);
  });
});
