import { z } from 'zod';
import type { BookingStatusKey, BookingStepKey } from './booking-workflow';

/* ------------------------------------------------------------------ */
/* Rooms, traveller types and pricing (pure: shared by API and web)    */
/* ------------------------------------------------------------------ */

export const BOOKABLE_OCCUPANCIES = ['SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD', 'QUINT', 'SHARING'] as const;
export type Occupancy = (typeof BOOKABLE_OCCUPANCIES)[number];

/** Beds in a room (adults + children). Infants share a bed. SHARING is priced and placed per person. */
export const ROOM_CAPACITY: Record<Occupancy, number> = { SINGLE: 1, DOUBLE: 2, TRIPLE: 3, QUAD: 4, QUINT: 5, SHARING: 1 };

export type TravelerKind = 'ADULT' | 'CHILD' | 'INFANT';

export const INFANT_MAX_AGE = 1; // under 2 on the return date
export const CHILD_MAX_AGE = 11; // 2 to 11
export const BALANCE_DUE_DAYS_BEFORE_DEPARTURE = 30;
export const PASSPORT_MIN_VALIDITY_MONTHS = 6; // after the return date
export const MAX_TRAVELERS_PER_BOOKING = 30;
export const SEAT_HOLD_MINUTES = 60;

export const dateOnlyString = (d: Date): string => d.toISOString().slice(0, 10);

/** Completed years between two YYYY-MM-DD dates. */
export function ageOn(dateOfBirth: string, on: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [oy, om, od] = on.split('-').map(Number) as [number, number, number];
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}

/** Fare category on the *return* date (airlines and the proposal's packages price by age at travel). */
export function travelerKindFor(dateOfBirth: string, returnDate: string): TravelerKind {
  const age = ageOn(dateOfBirth, returnDate);
  if (age <= INFANT_MAX_AGE) return 'INFANT';
  if (age <= CHILD_MAX_AGE) return 'CHILD';
  return 'ADULT';
}

/** Passport must be valid for 6 months after the return date. */
export function passportValidUntilOk(expiry: string, returnDate: string): boolean {
  const [y, m, d] = returnDate.split('-').map(Number) as [number, number, number];
  const limit = new Date(Date.UTC(y, m - 1 + PASSPORT_MIN_VALIDITY_MONTHS, d));
  return expiry >= dateOnlyString(limit);
}

/** Money helpers on integer minor units (paisa) so totals are exact. Accepts `"1234.50"`. */
export const toMinor = (value: string | number): number => Math.round(Number(value) * 100);
export const fromMinor = (minor: number): string => (minor / 100).toFixed(2);

export interface RoomRequest {
  occupancy: Occupancy;
  adults: number;
  children: number;
  infants: number;
}

export type PriceTable = Partial<Record<Occupancy, { adult: string; child: string | null; infant: string | null }>>;

export interface DepositRule {
  type: 'PERCENTAGE' | 'FIXED_PER_PERSON' | 'FIXED_PER_BOOKING';
  value: string;
}

export interface QuoteRoom extends RoomRequest {
  lineTotal: string;
  adultPrice: string;
  childPrice: string;
  infantPrice: string;
}

export interface Quote {
  rooms: QuoteRoom[];
  adults: number;
  children: number;
  infants: number;
  /** Seats consumed on the departure (infants travel on a parent's seat). */
  seats: number;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  depositAmount: string;
  balanceAmount: string;
}

export type QuoteError =
  | { code: 'no_rooms' }
  | { code: 'too_many_travelers' }
  | { code: 'room_needs_adult'; room: number }
  | { code: 'room_over_capacity'; room: number }
  | { code: 'no_price'; room: number; occupancy: Occupancy };

export function roomRequestError(room: RoomRequest, index: number): QuoteError | null {
  if (room.adults < 1) return { code: 'room_needs_adult', room: index };
  if (room.adults + room.children > ROOM_CAPACITY[room.occupancy]) return { code: 'room_over_capacity', room: index };
  return null;
}

/**
 * Prices a set of rooms. Child falls back to the adult fare when no child fare is set; an unset infant fare is free.
 * The server recomputes this from the database on every change: the browser's copy is only for display.
 */
export function computeQuote(rooms: RoomRequest[], prices: PriceTable, deposit: DepositRule): { ok: true; quote: Quote } | { ok: false; error: QuoteError } {
  if (rooms.length === 0) return { ok: false, error: { code: 'no_rooms' } };
  let adults = 0;
  let children = 0;
  let infants = 0;
  let subtotal = 0;
  const lines: QuoteRoom[] = [];
  for (const [i, room] of rooms.entries()) {
    const bad = roomRequestError(room, i);
    if (bad) return { ok: false, error: bad };
    const p = prices[room.occupancy];
    if (!p) return { ok: false, error: { code: 'no_price', room: i, occupancy: room.occupancy } };
    const adultPrice = toMinor(p.adult);
    const childPrice = p.child === null ? adultPrice : toMinor(p.child);
    const infantPrice = p.infant === null ? 0 : toMinor(p.infant);
    const line = room.adults * adultPrice + room.children * childPrice + room.infants * infantPrice;
    subtotal += line;
    adults += room.adults;
    children += room.children;
    infants += room.infants;
    lines.push({ ...room, lineTotal: fromMinor(line), adultPrice: fromMinor(adultPrice), childPrice: fromMinor(childPrice), infantPrice: fromMinor(infantPrice) });
  }
  if (adults + children + infants > MAX_TRAVELERS_PER_BOOKING) return { ok: false, error: { code: 'too_many_travelers' } };

  const grand = subtotal; // discounts and tax are not configured yet; both stay zero rather than invented
  let dep: number;
  if (deposit.type === 'PERCENTAGE') dep = Math.ceil((grand * Number(deposit.value)) / 100);
  else if (deposit.type === 'FIXED_PER_PERSON') dep = toMinor(deposit.value) * (adults + children);
  else dep = toMinor(deposit.value);
  dep = Math.min(Math.max(dep, 0), grand);

  return {
    ok: true,
    quote: {
      rooms: lines,
      adults,
      children,
      infants,
      seats: adults + children,
      subtotal: fromMinor(subtotal),
      discountTotal: '0.00',
      taxTotal: '0.00',
      grandTotal: fromMinor(grand),
      depositAmount: fromMinor(dep),
      balanceAmount: fromMinor(grand - dep),
    },
  };
}

export const QUOTE_ERROR_MESSAGE = (e: QuoteError): string => {
  switch (e.code) {
    case 'no_rooms':
      return 'Add at least one room.';
    case 'too_many_travelers':
      return `A single booking can include up to ${MAX_TRAVELERS_PER_BOOKING} travelers. Contact us for larger groups.`;
    case 'room_needs_adult':
      return `Room ${e.room + 1} needs at least one adult.`;
    case 'room_over_capacity':
      return `Room ${e.room + 1} has more people than beds.`;
    case 'no_price':
      return `Room ${e.room + 1}: ${e.occupancy.toLowerCase()} rooms are not available on this departure.`;
  }
};

/* ------------------------------------------------------------------ */
/* Request schemas                                                     */
/* ------------------------------------------------------------------ */

const trimmed = (max: number) => z.string().trim().min(1, 'Required').max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Enter a real date');
const optionalDate = z.preprocess((v) => (v === '' || v === null ? undefined : v), isoDate.optional());
const phone = z.string().trim().max(30).refine((v) => /^\+?[0-9\s\-()]+$/.test(v) && v.replace(/\D/g, '').length >= 7 && v.replace(/\D/g, '').length <= 15, 'Enter a valid phone number');
const optionalPhone = z.preprocess((v) => (v === '' || v === null ? undefined : v), phone.optional());
const country = z.string().trim().length(2, 'Use a 2-letter country code').transform((v) => v.toUpperCase());
const optionalCountry = z.preprocess((v) => (v === '' || v === null ? undefined : v), country.optional());

export const profileUpdateSchema = z.object({
  firstName: trimmed(80),
  lastName: trimmed(80),
  phone: optionalPhone,
  whatsappNumber: optionalPhone,
  whatsappOptIn: z.boolean().default(false),
  marketingOptIn: z.boolean().default(false),
  country: optionalCountry,
  city: optionalText(80),
  addressLine: optionalText(200),
  preferredLanguage: z.enum(['en', 'ur', 'ar']).default('en'),
});
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

export const TRAVELER_RELATIONSHIPS = ['SELF', 'SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'RELATIVE', 'OTHER'] as const;

const passportNumber = z.string().trim().regex(/^[A-Za-z0-9]{5,20}$/, 'Passport numbers are 5-20 letters and digits');
const nationalId = z.string().trim().regex(/^[A-Za-z0-9-]{5,25}$/, 'Use 5-25 letters, digits or dashes');
const optionalPassport = z.preprocess((v) => (v === '' || v === null ? undefined : v), passportNumber.optional());
const optionalNationalId = z.preprocess((v) => (v === '' || v === null ? undefined : v), nationalId.optional());
const optionalEmail = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().toLowerCase().email('Enter a valid email address').max(254).optional());
const optionalUuid = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().uuid().optional());

export const travelerInputSchema = z
  .object({
    relationship: z.enum(TRAVELER_RELATIONSHIPS).default('SELF'),
    title: optionalText(20),
    firstName: trimmed(80),
    middleName: optionalText(80),
    lastName: trimmed(80),
    fatherOrHusbandName: optionalText(120),
    gender: z.enum(['MALE', 'FEMALE']),
    dateOfBirth: isoDate,
    placeOfBirth: optionalText(80),
    nationality: country,
    passportNumber: optionalPassport,
    passportIssuingCountry: optionalCountry,
    passportIssueDate: optionalDate,
    passportExpiryDate: optionalDate,
    nationalId: optionalNationalId,
    phone: optionalPhone,
    email: optionalEmail,
    mahramTravelerId: optionalUuid,
    mahramRelationship: optionalText(40),
    specialRequirements: optionalText(500),
  })
  .superRefine((v, ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    if (v.dateOfBirth > today) ctx.addIssue({ code: 'custom', path: ['dateOfBirth'], message: 'Date of birth cannot be in the future' });
    if (v.passportIssueDate && v.passportExpiryDate && v.passportExpiryDate <= v.passportIssueDate)
      ctx.addIssue({ code: 'custom', path: ['passportExpiryDate'], message: 'Expiry must be after the issue date' });
    if (v.passportNumber && !v.passportExpiryDate) ctx.addIssue({ code: 'custom', path: ['passportExpiryDate'], message: 'Enter the passport expiry date' });
  });
export type TravelerInput = z.infer<typeof travelerInputSchema>;

export const bookingCreateSchema = z.object({
  departureId: z.string().uuid(),
  rooms: z
    .array(
      z.object({
        occupancy: z.enum(BOOKABLE_OCCUPANCIES),
        adults: z.number().int().min(0).max(5),
        children: z.number().int().min(0).max(4),
        infants: z.number().int().min(0).max(4),
      }),
    )
    .min(1)
    .max(MAX_TRAVELERS_PER_BOOKING),
  specialRequests: optionalText(1000),
});
export type BookingCreateInput = z.infer<typeof bookingCreateSchema>;

export const quoteRequestSchema = bookingCreateSchema.pick({ departureId: true, rooms: true });

/** One entry per person: who sits in which room. The server checks the counts against the room plan. */
export const bookingTravelersSchema = z.object({
  assignments: z.array(z.object({ roomIndex: z.number().int().min(0).max(MAX_TRAVELERS_PER_BOOKING), travelerId: z.string().uuid() })).min(1).max(MAX_TRAVELERS_PER_BOOKING),
  leadTravelerId: z.string().uuid(),
  specialRequests: optionalText(1000),
});
export type BookingTravelersInput = z.infer<typeof bookingTravelersSchema>;

export const cancelBookingSchema = z.object({ reason: optionalText(500) });

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */

export interface ProfileDto {
  userId: string;
  customerId: string;
  email: string;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  phone: string | null;
  whatsappNumber: string | null;
  whatsappOptIn: boolean;
  marketingOptIn: boolean;
  country: string | null;
  city: string | null;
  addressLine: string | null;
  preferredLanguage: string;
}

export interface TravelerDto {
  id: string;
  relationship: (typeof TRAVELER_RELATIONSHIPS)[number];
  title: string | null;
  firstName: string;
  middleName: string | null;
  lastName: string;
  fatherOrHusbandName: string | null;
  gender: 'MALE' | 'FEMALE';
  dateOfBirth: string;
  placeOfBirth: string | null;
  nationality: string;
  /** Identity numbers are never returned in full. */
  passportNumberMasked: string | null;
  passportIssuingCountry: string | null;
  passportIssueDate: string | null;
  passportExpiryDate: string | null;
  nationalIdMasked: string | null;
  phone: string | null;
  email: string | null;
  mahramTravelerId: string | null;
  mahramRelationship: string | null;
  specialRequirements: string | null;
}

export interface BookingTravelerDto {
  travelerId: string;
  name: string;
  kind: TravelerKind;
  roomIndex: number | null;
  isLead: boolean;
  price: string;
}

export interface BookingRoomDto {
  index: number;
  occupancy: Occupancy;
  adults: number;
  children: number;
  infants: number;
  pricePerAdult: string;
  lineTotal: string;
}

export interface BookingSummaryDto {
  id: string;
  reference: string;
  status: BookingStatusKey;
  paymentStatus: string;
  currentStep: BookingStepKey;
  packageTitle: string;
  packageSlug: string;
  departureDate: string;
  returnDate: string;
  travelers: number;
  currency: string;
  grandTotal: string;
  amountPaid: string;
  balanceDue: string;
  seatHoldExpiresAt: string | null;
  createdAt: string;
}

export interface BookingDetailDto extends BookingSummaryDto {
  departureCity: string | null;
  airline: string | null;
  adults: number;
  children: number;
  infants: number;
  rooms: BookingRoomDto[];
  travelerList: BookingTravelerDto[];
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  depositAmount: string;
  balanceDueDate: string | null;
  specialRequests: string | null;
  submittedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  history: { status: BookingStatusKey; at: string; note: string | null }[];
  /** What is still missing before the booking can be submitted. Empty when ready. */
  blockers: string[];
  canCancel: boolean;
}

export interface QuoteResponse extends Quote {
  currency: string;
  departureId: string;
  seatsLeft: number;
}

/** What the booking form needs to offer rooms for one departure. */
export interface DepartureOptionsDto {
  departureId: string;
  packageTitle: string;
  packageSlug: string;
  currency: string;
  departureDate: string;
  returnDate: string;
  departureCity: string | null;
  airline: string | null;
  seatsLeft: number;
  bookable: boolean;
  prices: PriceTable;
  deposit: DepositRule;
}
