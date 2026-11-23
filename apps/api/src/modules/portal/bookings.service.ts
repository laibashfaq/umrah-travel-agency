import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  BALANCE_DUE_DAYS_BEFORE_DEPARTURE,
  canTransitionBooking,
  computeQuote,
  fromMinor,
  passportValidUntilOk,
  QUOTE_ERROR_MESSAGE,
  SEAT_HOLD_MINUTES,
  toMinor,
  travelerKindFor,
  type BookingCreateInput,
  type BookingDetailDto,
  type BookingSummaryDto,
  type BookingTravelersInput,
  type DepartureOptionsDto,
  type DepositRule,
  type Occupancy,
  type Paginated,
  type PriceTable,
  type Quote,
  type QuoteResponse,
  type TravelerKind,
} from '@umrah/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import type { ClientContext } from '../../common/http/request-context';
import { ReferenceService } from '../../common/references.service';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import type { Prisma } from '../../generated/prisma/client';
import { InvoicesService } from '../../finance/invoices.service';
import { MoneyService } from '../../finance/money.service';
import { MailerService } from '../../mail/mailer.service';
import { PrismaService } from '../../prisma/prisma.service';
import { isBookable, utcToday } from '../catalog/catalog.mappers';
import { fullName, requireCustomerId, ymd } from './portal.util';

const MAX_OPEN_DRAFTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

type Tx = Prisma.TransactionClient;

export const detailInclude = {
  package: { select: { title: true, slug: true } },
  departure: { select: { departureDate: true, returnDate: true, departureCity: true, airline: true } },
  rooms: { orderBy: { sortOrder: 'asc' } },
  travelers: { include: { traveler: true } },
  statusHistory: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.BookingInclude;
export type BookingRow = Prisma.BookingGetPayload<{ include: typeof detailInclude }>;

interface Snapshot {
  quote: Quote;
  prices: PriceTable;
  deposit: DepositRule;
}

const money = (d: { toString(): string }): string => fromMinor(toMinor(d.toString()));

const asSnapshot = (row: { pricingSnapshot: Prisma.JsonValue | null }): Snapshot => row.pricingSnapshot as unknown as Snapshot;

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: ReferenceService,
    private readonly audit: AuditService,
    private readonly mail: MailerService,
    private readonly invoices: InvoicesService,
    private readonly money: MoneyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /* ------------------------------- quote ------------------------------- */

  async quote(input: Pick<BookingCreateInput, 'departureId' | 'rooms'>): Promise<QuoteResponse> {
    const dep = await this.loadDeparture(input.departureId);
    const { quote, seatsLeft } = this.priceDeparture(dep, input.rooms);
    return { ...quote, currency: dep.package.currency, departureId: dep.id, seatsLeft };
  }

  async departureOptions(id: string): Promise<DepartureOptionsDto> {
    const dep = await this.loadDeparture(id);
    return {
      departureId: dep.id,
      packageTitle: dep.package.title,
      packageSlug: dep.package.slug,
      currency: dep.package.currency,
      departureDate: ymd(dep.departureDate) as string,
      returnDate: ymd(dep.returnDate) as string,
      departureCity: dep.departureCity,
      airline: dep.airline,
      seatsLeft: Math.max(0, dep.seatsTotal - dep.seatsReserved),
      bookable: isBookable(dep, utcToday()),
      prices: this.priceTable(dep.prices),
      deposit: { type: dep.package.depositType, value: dep.package.depositValue.toString() },
    };
  }

  /* ------------------------------- create ------------------------------ */

  async createDraft(user: AuthUser, input: BookingCreateInput, ctx: ClientContext): Promise<BookingDetailDto> {
    const customerId = requireCustomerId(user);
    await this.expireHolds();
    const open = await this.prisma.booking.count({ where: { customerId, status: 'DRAFT', deletedAt: null } });
    if (open >= MAX_OPEN_DRAFTS) {
      throw new ConflictException({ message: `You already have ${MAX_OPEN_DRAFTS} unfinished bookings. Finish or cancel one first.`, code: 'too_many_drafts' });
    }

    const dep = await this.loadDeparture(input.departureId);
    const { quote } = this.priceDeparture(dep, input.rooms);
    const deposit: DepositRule = { type: dep.package.depositType, value: dep.package.depositValue.toString() };
    const prices = this.priceTable(dep.prices);
    const now = new Date();

    const id = await this.prisma.$transaction(async (tx) => {
      // Reserve seats atomically: the WHERE clause is what stops two customers taking the last seat.
      const reserved = await tx.$executeRaw`
        UPDATE "PackageDeparture" SET "seatsReserved" = "seatsReserved" + ${quote.seats}
        WHERE "id" = ${dep.id}::uuid AND "status" = 'OPEN' AND "seatsReserved" + ${quote.seats} <= "seatsTotal"`;
      if (reserved !== 1) {
        throw new ConflictException({ message: 'Sorry, there are not enough seats left on this departure.', code: 'sold_out' });
      }
      const reference = await this.refs.next('UMR', tx);
      const booking = await tx.booking.create({
        data: {
          reference,
          customerId,
          packageId: dep.packageId,
          departureId: dep.id,
          status: 'DRAFT',
          currentStep: 'TRAVELER_DETAILS',
          source: 'WEBSITE',
          adults: quote.adults,
          children: quote.children,
          infants: quote.infants,
          currency: dep.package.currency,
          subtotal: quote.subtotal,
          discountTotal: quote.discountTotal,
          taxTotal: quote.taxTotal,
          grandTotal: quote.grandTotal,
          depositAmount: quote.depositAmount,
          balanceDue: quote.grandTotal,
          balanceDueDate: this.balanceDueDate(dep.departureDate, now),
          specialRequests: input.specialRequests ?? null,
          seatHoldExpiresAt: new Date(now.getTime() + SEAT_HOLD_MINUTES * 60_000),
          createdById: user.id,
          pricingSnapshot: { quote, prices, deposit, package: { slug: dep.package.slug, title: dep.package.title } } as unknown as Prisma.InputJsonValue,
          rooms: {
            create: quote.rooms.map((r, i) => ({ occupancy: r.occupancy, label: `Room ${i + 1}`, pricePerAdult: r.adultPrice, sortOrder: i })),
          },
          statusHistory: { create: { fromStatus: null, toStatus: 'DRAFT', changedById: user.id, note: 'Booking started online' } },
        },
        select: { id: true },
      });
      await this.audit.record({ action: 'booking.created', entityType: 'Booking', entityId: booking.id, actorUserId: user.id, after: { reference, departureId: dep.id, grandTotal: quote.grandTotal }, ...ctx }, tx);
      return booking.id;
    });
    return this.get(user, id);
  }

  /* -------------------------------- read ------------------------------- */

  async list(user: AuthUser, page: number, pageSize: number): Promise<Paginated<BookingSummaryDto>> {
    const customerId = requireCustomerId(user);
    await this.expireHolds(customerId);
    const where = { customerId, deletedAt: null } satisfies Prisma.BookingWhereInput;
    const [total, rows] = await Promise.all([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: detailInclude }),
    ]);
    return { items: rows.map((r) => this.summary(r)), meta: { total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) } };
  }

  async get(user: AuthUser, id: string): Promise<BookingDetailDto> {
    const customerId = requireCustomerId(user);
    await this.expireHolds(customerId);
    return this.detail(await this.owned(customerId, id));
  }

  /* ------------------------------ travelers ----------------------------- */

  async setTravelers(user: AuthUser, id: string, input: BookingTravelersInput, ctx: ClientContext): Promise<BookingDetailDto> {
    const customerId = requireCustomerId(user);
    const booking = await this.editableDraft(customerId, id);
    const snap = asSnapshot(booking);
    const returnDate = ymd(booking.departure.returnDate) as string;

    const ids = input.assignments.map((a) => a.travelerId);
    if (new Set(ids).size !== ids.length) throw this.invalid('Each traveler can only be added once.');
    const travelers = await this.prisma.traveler.findMany({ where: { id: { in: ids }, customerId, deletedAt: null } });
    if (travelers.length !== ids.length) throw this.invalid('One of the selected travelers could not be found.');
    const byId = new Map(travelers.map((t) => [t.id, t]));
    if (!ids.includes(input.leadTravelerId)) throw this.invalid('The lead traveler must be one of the people travelling.');

    const kindOf = (travelerId: string): TravelerKind => travelerKindFor(ymd((byId.get(travelerId) as { dateOfBirth: Date }).dateOfBirth) as string, returnDate);
    if (kindOf(input.leadTravelerId) !== 'ADULT') throw this.invalid('The lead traveler must be an adult.');

    // The people in each room must match the room plan that was priced.
    const problems: string[] = [];
    for (const [i, room] of snap.quote.rooms.entries()) {
      const here = input.assignments.filter((a) => a.roomIndex === i).map((a) => kindOf(a.travelerId));
      const have = { ADULT: here.filter((k) => k === 'ADULT').length, CHILD: here.filter((k) => k === 'CHILD').length, INFANT: here.filter((k) => k === 'INFANT').length };
      if (have.ADULT !== room.adults || have.CHILD !== room.children || have.INFANT !== room.infants) {
        problems.push(`Room ${i + 1} needs ${room.adults} adult(s), ${room.children} child(ren) and ${room.infants} infant(s) by age on the return date, but has ${have.ADULT}, ${have.CHILD} and ${have.INFANT}.`);
      }
    }
    if (input.assignments.some((a) => a.roomIndex >= snap.quote.rooms.length)) problems.push('A traveler was placed in a room that does not exist.');
    if (problems.length > 0) throw new UnprocessableEntityException({ message: problems.join(' '), code: 'room_mismatch' });

    await this.prisma.$transaction(async (tx) => {
      await tx.bookingTraveler.deleteMany({ where: { bookingId: id } });
      for (const a of input.assignments) {
        const kind = kindOf(a.travelerId);
        const room = booking.rooms[a.roomIndex] as { id: string };
        const line = snap.quote.rooms[a.roomIndex] as { adultPrice: string; childPrice: string; infantPrice: string };
        await tx.bookingTraveler.create({
          data: {
            bookingId: id,
            travelerId: a.travelerId,
            bookingRoomId: room.id,
            travelerType: kind,
            isLeadTraveler: a.travelerId === input.leadTravelerId,
            price: kind === 'ADULT' ? line.adultPrice : kind === 'CHILD' ? line.childPrice : line.infantPrice,
          },
        });
      }
      await tx.booking.update({
        where: { id },
        data: {
          currentStep: 'PAYMENT',
          specialRequests: input.specialRequests ?? booking.specialRequests,
          seatHoldExpiresAt: new Date(Date.now() + SEAT_HOLD_MINUTES * 60_000),
        },
      });
      await this.audit.record({ action: 'booking.travelers_set', entityType: 'Booking', entityId: id, actorUserId: user.id, after: { travelers: ids.length }, ...ctx }, tx);
    });
    return this.get(user, id);
  }

  /* ------------------------------- submit ------------------------------ */

  async submit(user: AuthUser, id: string, ctx: ClientContext): Promise<BookingDetailDto> {
    const customerId = requireCustomerId(user);
    const booking = await this.editableDraft(customerId, id);
    const blockers = this.blockers(booking);
    if (blockers.length > 0) {
      throw new UnprocessableEntityException({ message: `Before you can submit: ${blockers.join(' ')}`, code: 'booking_incomplete', errors: blockers });
    }
    if (!canTransitionBooking('DRAFT', 'PENDING_PAYMENT')) throw new ConflictException('Booking cannot be submitted.');

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.booking.updateMany({
        where: { id, status: 'DRAFT' },
        data: { status: 'PENDING_PAYMENT', currentStep: 'CONFIRMATION', submittedAt: now, seatHoldExpiresAt: null, balanceDueDate: this.balanceDueDate(booking.departure.departureDate, now) },
      });
      if (moved.count !== 1) throw new ConflictException({ message: 'This booking was just changed. Refresh and try again.', code: 'conflict' });
      await tx.bookingStatusHistory.create({ data: { bookingId: id, fromStatus: 'DRAFT', toStatus: 'PENDING_PAYMENT', changedById: user.id, note: 'Submitted by customer' } });
      await this.invoices.issueForBooking(tx, id, null);
      await this.audit.record({ action: 'booking.submitted', entityType: 'Booking', entityId: id, actorUserId: user.id, after: { reference: booking.reference, grandTotal: booking.grandTotal }, ...ctx }, tx);
    });

    void this.mail.sendTemplate(
      'booking.submitted',
      user.email,
      { firstName: user.firstName, reference: booking.reference, packageTitle: booking.package.title, departureDate: ymd(booking.departure.departureDate) as string, amountDue: `${booking.currency} ${money(booking.grandTotal)}`, link: `${this.env.WEB_URL}/account/bookings/${id}` },
      { userId: user.id, customerId },
    );
    return this.get(user, id);
  }

  /* ------------------------------- cancel ------------------------------ */

  async cancel(user: AuthUser, id: string, reason: string | undefined, ctx: ClientContext): Promise<BookingDetailDto> {
    const customerId = requireCustomerId(user);
    const booking = await this.owned(customerId, id);
    if (booking.status === 'CANCELLED') return this.detail(booking);
    if (!this.canCancel(booking)) {
      throw new ConflictException({ message: 'This booking can no longer be cancelled online. Please contact us and we will help.', code: 'contact_support' });
    }
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.booking.updateMany({
        where: { id, status: { in: ['DRAFT', 'PENDING_PAYMENT'] } },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason ?? 'Cancelled by customer', seatHoldExpiresAt: null },
      });
      if (moved.count !== 1) throw new ConflictException({ message: 'This booking was just changed. Refresh and try again.', code: 'conflict' });
      await this.releaseSeats(tx, booking.departureId, booking.adults + booking.children);
      await tx.bookingStatusHistory.create({ data: { bookingId: id, fromStatus: booking.status, toStatus: 'CANCELLED', changedById: user.id, note: reason ?? 'Cancelled by customer' } });
      await this.money.sync(tx, id);
      await this.audit.record({ action: 'booking.cancelled', entityType: 'Booking', entityId: id, actorUserId: user.id, before: { status: booking.status }, metadata: { reason }, ...ctx }, tx);
    });
    return this.get(user, id);
  }

  /* ------------------------ seat holds (expiry sweep) ------------------------ */

  /** Cancels unfinished drafts whose seat hold has run out and gives the seats back. Safe to call concurrently. */
  async expireHolds(customerId?: string): Promise<number> {
    const stale = await this.prisma.booking.findMany({
      where: { status: 'DRAFT', deletedAt: null, seatHoldExpiresAt: { lt: new Date() }, ...(customerId ? { customerId } : {}) },
      select: { id: true, departureId: true, adults: true, children: true },
      take: 200,
    });
    let released = 0;
    for (const b of stale) {
      await this.prisma.$transaction(async (tx) => {
        const moved = await tx.booking.updateMany({
          where: { id: b.id, status: 'DRAFT' },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Seat hold expired', seatHoldExpiresAt: null },
        });
        if (moved.count !== 1) return; // someone else already handled it: never release twice
        await this.releaseSeats(tx, b.departureId, b.adults + b.children);
        await tx.bookingStatusHistory.create({ data: { bookingId: b.id, fromStatus: 'DRAFT', toStatus: 'CANCELLED', note: 'Seat hold expired' } });
        await this.audit.record({ action: 'booking.hold_expired', entityType: 'Booking', entityId: b.id, actorType: 'SYSTEM' }, tx);
        released += 1;
      });
    }
    return released;
  }

  /* ------------------------------ internals ------------------------------ */

  async releaseSeats(tx: Tx, departureId: string, seats: number) {
    await tx.$executeRaw`UPDATE "PackageDeparture" SET "seatsReserved" = GREATEST("seatsReserved" - ${seats}, 0) WHERE "id" = ${departureId}::uuid`;
  }

  balanceDueDate(departureDate: Date, now: Date): Date {
    const due = new Date(departureDate.getTime() - BALANCE_DUE_DAYS_BEFORE_DEPARTURE * DAY_MS);
    const today = utcToday(now);
    return due < today ? today : due;
  }

  private invalid(message: string) {
    return new UnprocessableEntityException({ message, code: 'invalid_booking' });
  }

  private async owned(customerId: string, id: string): Promise<BookingRow> {
    const row = await this.prisma.booking.findFirst({ where: { id, customerId, deletedAt: null }, include: detailInclude });
    // Same answer for "not yours" and "does not exist" so booking ids cannot be probed.
    if (!row) throw new NotFoundException({ message: 'Booking not found.', code: 'not_found' });
    return row;
  }

  private async editableDraft(customerId: string, id: string): Promise<BookingRow> {
    await this.expireHolds(customerId);
    const row = await this.owned(customerId, id);
    if (row.status === 'CANCELLED' && row.cancellationReason === 'Seat hold expired') {
      throw new ConflictException({ message: 'Your seat hold expired. Please start the booking again.', code: 'hold_expired' });
    }
    if (row.status !== 'DRAFT') throw new ConflictException({ message: 'This booking has already been submitted.', code: 'not_editable' });
    return row;
  }

  private async loadDeparture(id: string) {
    const dep = await this.prisma.packageDeparture.findFirst({
      where: { id, package: { status: 'PUBLISHED', deletedAt: null } },
      include: { prices: true, package: true },
    });
    if (!dep) throw new NotFoundException({ message: 'Departure not found.', code: 'not_found' });
    return dep;
  }

  private priceTable(prices: { occupancy: string; adultPrice: { toString(): string }; childPrice: { toString(): string } | null; infantPrice: { toString(): string } | null }[]): PriceTable {
    const table: PriceTable = {};
    for (const p of prices) {
      table[p.occupancy as Occupancy] = { adult: p.adultPrice.toString(), child: p.childPrice?.toString() ?? null, infant: p.infantPrice?.toString() ?? null };
    }
    return table;
  }

  private priceDeparture(dep: Awaited<ReturnType<BookingsService['loadDeparture']>>, rooms: BookingCreateInput['rooms']) {
    if (!isBookable(dep, utcToday())) {
      throw new ConflictException({ message: 'This departure is no longer open for booking.', code: 'departure_closed' });
    }
    const result = computeQuote(rooms, this.priceTable(dep.prices), { type: dep.package.depositType, value: dep.package.depositValue.toString() });
    if (!result.ok) throw new UnprocessableEntityException({ message: QUOTE_ERROR_MESSAGE(result.error), code: result.error.code });
    const seatsLeft = dep.seatsTotal - dep.seatsReserved;
    if (result.quote.seats > seatsLeft) {
      throw new ConflictException({ message: seatsLeft > 0 ? `Only ${seatsLeft} seat(s) left on this departure.` : 'This departure is sold out.', code: 'sold_out' });
    }
    return { quote: result.quote, seatsLeft };
  }

  private canCancel(b: { status: string; amountPaid: { toString(): string } }): boolean {
    return (b.status === 'DRAFT' || b.status === 'PENDING_PAYMENT') && toMinor(b.amountPaid.toString()) === 0;
  }

  /** What still stops a draft from being submitted (also recomputed at submit time, never trusted from the client). */
  private blockers(b: BookingRow): string[] {
    const out: string[] = [];
    const expected = b.adults + b.children + b.infants;
    if (b.travelers.length !== expected) out.push(`Choose all ${expected} traveler(s).`);
    const returnDate = ymd(b.departure.returnDate) as string;
    for (const bt of b.travelers) {
      const t = bt.traveler;
      const name = fullName(t);
      if (travelerKindFor(ymd(t.dateOfBirth) as string, returnDate) !== bt.travelerType) out.push(`${name}: age category changed, please re-select travelers.`);
      if (!t.passportNumberEnc || !t.passportExpiryDate) out.push(`${name}: add passport number and expiry date.`);
      else if (!passportValidUntilOk(ymd(t.passportExpiryDate) as string, returnDate)) out.push(`${name}: passport must be valid for 6 months after the return date.`);
    }
    if (b.travelers.length > 0 && !b.travelers.some((x) => x.isLeadTraveler)) out.push('Choose a lead traveler.');
    return out;
  }

  summary(b: BookingRow): BookingSummaryDto {
    return {
      id: b.id,
      reference: b.reference,
      status: b.status,
      paymentStatus: b.paymentStatus,
      currentStep: b.currentStep,
      packageTitle: b.package.title,
      packageSlug: b.package.slug,
      departureDate: ymd(b.departure.departureDate) as string,
      returnDate: ymd(b.departure.returnDate) as string,
      travelers: b.adults + b.children + b.infants,
      currency: b.currency,
      grandTotal: money(b.grandTotal),
      amountPaid: money(b.amountPaid),
      balanceDue: money(b.balanceDue),
      seatHoldExpiresAt: b.seatHoldExpiresAt?.toISOString() ?? null,
      createdAt: b.createdAt.toISOString(),
    };
  }

  detail(b: BookingRow): BookingDetailDto {
    const snap = asSnapshot(b);
    const roomIndex = new Map(b.rooms.map((r, i) => [r.id, i]));
    return {
      ...this.summary(b),
      departureCity: b.departure.departureCity,
      airline: b.departure.airline,
      adults: b.adults,
      children: b.children,
      infants: b.infants,
      rooms: b.rooms.map((r, i) => {
        const line = snap.quote.rooms[i];
        return { index: i, occupancy: r.occupancy as Occupancy, adults: line?.adults ?? 0, children: line?.children ?? 0, infants: line?.infants ?? 0, pricePerAdult: money(r.pricePerAdult), lineTotal: line?.lineTotal ?? fromMinor(0) };
      }),
      travelerList: b.travelers.map((bt) => ({
        travelerId: bt.travelerId,
        name: fullName(bt.traveler),
        kind: bt.travelerType,
        roomIndex: bt.bookingRoomId ? (roomIndex.get(bt.bookingRoomId) ?? null) : null,
        isLead: bt.isLeadTraveler,
        price: money(bt.price),
      })),
      subtotal: money(b.subtotal),
      discountTotal: money(b.discountTotal),
      taxTotal: money(b.taxTotal),
      depositAmount: money(b.depositAmount),
      balanceDueDate: ymd(b.balanceDueDate),
      specialRequests: b.specialRequests,
      submittedAt: b.submittedAt?.toISOString() ?? null,
      cancelledAt: b.cancelledAt?.toISOString() ?? null,
      cancellationReason: b.cancellationReason,
      history: b.statusHistory.map((h) => ({ status: h.toStatus, at: h.createdAt.toISOString(), note: h.note })),
      blockers: b.status === 'DRAFT' ? this.blockers(b) : [],
      canCancel: this.canCancel(b),
    };
  }
}
