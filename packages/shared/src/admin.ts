import { z } from 'zod';
import type { BookingStatusKey, BookingStepKey } from './booking-workflow';
import type { Paginated } from './public-api';
import { PACKAGE_TIERS } from './schemas';
import type { BookingDetailDto, BookingSummaryDto, Occupancy, TravelerDto } from './portal';

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

const pageParams = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Enter a real date');
const optionalDate = z.preprocess(blankToUndefined, isoDate.optional());
const money = z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Enter an amount like 250000 or 250000.50');
const optionalMoney = z.preprocess(blankToUndefined, money.optional());

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export interface DashboardStatsDto {
  generatedAt: string;
  bookings: { total: number; byStatus: Partial<Record<BookingStatusKey, number>>; awaitingAction: number; createdLast7Days: number };
  revenue: { currency: string; bookedValue: string; note: string };
  customers: { total: number; newLast30Days: number };
  catalog: { publishedPackages: number; openDepartures: number; seatsLeft: number; departuresLeavingIn30Days: number };
  recentBookings: BookingSummaryDto[];
}

/* ------------------------------------------------------------------ */
/* Bookings                                                            */
/* ------------------------------------------------------------------ */

export const BOOKING_STATUS_VALUES = ['DRAFT', 'PENDING_PAYMENT', 'CONFIRMED', 'VISA_PROCESSING', 'TRAVEL_PREPARATION', 'COMPLETED', 'CANCELLED'] as const;
export const PAYMENT_STATUS_VALUES = ['UNPAID', 'DEPOSIT_PAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

export const adminBookingQuery = z.object({
  q: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
  status: z.preprocess(blankToUndefined, z.enum(BOOKING_STATUS_VALUES).optional()),
  paymentStatus: z.preprocess(blankToUndefined, z.enum(PAYMENT_STATUS_VALUES).optional()),
  assignedToId: z.preprocess(blankToUndefined, z.union([z.literal('none'), z.string().uuid()]).optional()),
  departureFrom: optionalDate,
  departureTo: optionalDate,
  ...pageParams,
});
export type AdminBookingQuery = z.infer<typeof adminBookingQuery>;

export const bookingStatusChangeSchema = z.object({
  toStatus: z.enum(BOOKING_STATUS_VALUES),
  note: optionalText(500),
});
export type BookingStatusChangeInput = z.infer<typeof bookingStatusChangeSchema>;

export const bookingAssignSchema = z.object({ assignedToId: z.string().uuid().nullable() });
export const noteSchema = z.object({ body: z.string().trim().min(1, 'Write a note').max(2000) });

export interface AdminBookingRowDto extends BookingSummaryDto {
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  assignedToName: string | null;
  source: string;
}

export interface NoteDto {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
}

export interface AdminBookingDetailDto extends Omit<BookingDetailDto, 'canCancel'> {
  customer: { id: string; name: string; email: string | null; phone: string | null; whatsappNumber: string | null };
  assignedToId: string | null;
  assignedToName: string | null;
  source: string;
  notes: NoteDto[];
  /** Statuses the booking may move to next (workflow rules). */
  allowedTransitions: BookingStatusKey[];
  staffTravelers: (TravelerDto & { kind: string; roomIndex: number | null; isLead: boolean })[];
  currentStep: BookingStepKey;
}

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

export const adminCustomerQuery = z.object({ q: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()), ...pageParams });

export interface AdminCustomerRowDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  hasAccount: boolean;
  bookings: number;
  createdAt: string;
}

export interface AdminCustomerDetailDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  whatsappNumber: string | null;
  whatsappOptIn: boolean;
  marketingOptIn: boolean;
  country: string | null;
  city: string | null;
  addressLine: string | null;
  preferredLanguage: string;
  hasAccount: boolean;
  createdAt: string;
  travelers: TravelerDto[];
  bookings: BookingSummaryDto[];
  notes: NoteDto[];
}

/* ------------------------------------------------------------------ */
/* Packages and departures                                             */
/* ------------------------------------------------------------------ */

export const MEAL_PLANS = ['ROOM_ONLY', 'BREAKFAST', 'HALF_BOARD', 'FULL_BOARD'] as const;
export const DEPOSIT_TYPES = ['PERCENTAGE', 'FIXED_PER_PERSON', 'FIXED_PER_BOOKING'] as const;
export const PUBLISH_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const DEPARTURE_STATUSES = ['SCHEDULED', 'OPEN', 'CLOSED', 'SOLD_OUT', 'CANCELLED', 'COMPLETED'] as const;

const lines = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : v),
  z.array(z.string().trim().min(1).max(200)).max(40),
);

export const adminPackageQuery = z.object({
  q: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
  status: z.preprocess(blankToUndefined, z.enum(PUBLISH_STATUSES).optional()),
  ...pageParams,
});

export const packageInputSchema = z
  .object({
    title: z.string().trim().min(3, 'Enter a title').max(160),
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case letters, digits and single dashes').min(3).max(120),
    subtitle: optionalText(200),
    summary: optionalText(500),
    description: optionalText(8000),
    tier: z.enum(PACKAGE_TIERS),
    durationDays: z.coerce.number().int().min(1).max(60),
    nightsMakkah: z.coerce.number().int().min(0).max(60),
    nightsMadinah: z.coerce.number().int().min(0).max(60),
    departureCities: lines,
    mealPlan: z.enum(MEAL_PLANS),
    inclusions: lines,
    exclusions: lines,
    terms: optionalText(8000),
    visaIncluded: z.coerce.boolean(),
    flightIncluded: z.coerce.boolean(),
    transportIncluded: z.coerce.boolean(),
    ziyaratIncluded: z.coerce.boolean(),
    depositType: z.enum(DEPOSIT_TYPES),
    depositValue: money,
    isFeatured: z.coerce.boolean(),
    seoTitle: optionalText(160),
    seoDescription: optionalText(320),
  })
  .superRefine((v, ctx) => {
    if (v.nightsMakkah + v.nightsMadinah > v.durationDays) ctx.addIssue({ code: 'custom', path: ['nightsMakkah'], message: 'Hotel nights cannot exceed the number of days' });
    if (v.depositType === 'PERCENTAGE' && Number(v.depositValue) > 100) ctx.addIssue({ code: 'custom', path: ['depositValue'], message: 'A percentage cannot be more than 100' });
  });
export type PackageInput = z.infer<typeof packageInputSchema>;

export const packageStatusSchema = z.object({ status: z.enum(PUBLISH_STATUSES) });

const priceRow = z.object({
  occupancy: z.enum(['SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD', 'QUINT', 'SHARING']),
  adultPrice: money,
  childPrice: optionalMoney,
  infantPrice: optionalMoney,
});

export const departureInputSchema = z
  .object({
    departureDate: isoDate,
    returnDate: isoDate,
    departureCity: optionalText(80),
    airline: optionalText(80),
    flightDetails: optionalText(500),
    seatsTotal: z.coerce.number().int().min(1).max(1000),
    bookingCutoffDate: optionalDate,
    status: z.enum(DEPARTURE_STATUSES),
    notes: optionalText(500),
    prices: z.array(priceRow).max(6),
  })
  .superRefine((v, ctx) => {
    if (v.returnDate <= v.departureDate) ctx.addIssue({ code: 'custom', path: ['returnDate'], message: 'Return must be after departure' });
    if (v.bookingCutoffDate && v.bookingCutoffDate > v.departureDate) ctx.addIssue({ code: 'custom', path: ['bookingCutoffDate'], message: 'Cut-off must be on or before departure' });
    const seen = new Set<string>();
    for (const [i, p] of v.prices.entries()) {
      if (seen.has(p.occupancy)) ctx.addIssue({ code: 'custom', path: ['prices', i, 'occupancy'], message: 'Each room type can be priced once' });
      seen.add(p.occupancy);
    }
  });
export type DepartureInput = z.infer<typeof departureInputSchema>;

export interface AdminPackageRowDto {
  id: string;
  slug: string;
  title: string;
  tier: string;
  status: string;
  durationDays: number;
  startingPrice: string | null;
  currency: string;
  openDepartures: number;
  isFeatured: boolean;
  updatedAt: string;
}

export interface AdminDepartureDto {
  id: string;
  departureDate: string;
  returnDate: string;
  departureCity: string | null;
  airline: string | null;
  flightDetails: string | null;
  seatsTotal: number;
  seatsReserved: number;
  bookingCutoffDate: string | null;
  status: string;
  notes: string | null;
  bookings: number;
  prices: { occupancy: Occupancy; adultPrice: string; childPrice: string | null; infantPrice: string | null }[];
}

export interface AdminPackageDetailDto extends Omit<AdminPackageRowDto, 'openDepartures'> {
  subtitle: string | null;
  summary: string | null;
  description: string | null;
  nightsMakkah: number;
  nightsMadinah: number;
  departureCities: string[];
  mealPlan: string;
  inclusions: string[];
  exclusions: string[];
  terms: string | null;
  visaIncluded: boolean;
  flightIncluded: boolean;
  transportIncluded: boolean;
  ziyaratIncluded: boolean;
  depositType: string;
  depositValue: string;
  seoTitle: string | null;
  seoDescription: string | null;
  departures: AdminDepartureDto[];
  /** What blocks publishing right now. */
  publishBlockers: string[];
}
