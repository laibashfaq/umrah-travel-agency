import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  BOOKING_TRANSITIONS,
  canTransitionBooking,
  toMinor,
  type AdminBookingDetailDto,
  type AdminBookingQuery,
  type AdminBookingRowDto,
  type BookingStatusChangeInput,
  type BookingStatusKey,
  type NoteDto,
  type Paginated,
} from '@umrah/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { ClientContext } from '../common/http/request-context';
import type { Prisma } from '../generated/prisma/client';
import { MoneyService } from '../finance/money.service';
import { MailerService } from '../mail/mailer.service';
import { BookingsService, detailInclude, type BookingRow } from '../modules/portal/bookings.service';
import { travelerToDto, ymd } from '../modules/portal/portal.util';
import { FieldEncryption } from '../common/crypto/field-encryption';
import { PrismaService } from '../prisma/prisma.service';

const adminInclude = {
  ...detailInclude,
  customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, whatsappNumber: true } },
  assignedTo: { select: { id: true, firstName: true, lastName: true } },
  notes: { orderBy: { createdAt: 'desc' }, include: { author: { select: { firstName: true, lastName: true } } } },
} satisfies Prisma.BookingInclude;
type AdminBookingRow = Prisma.BookingGetPayload<{ include: typeof adminInclude }>;

/** Customers complete DRAFT -> PENDING_PAYMENT themselves (travelers, passports); staff take it from there. */
export function staffTransitions(from: BookingStatusKey): BookingStatusKey[] {
  return BOOKING_TRANSITIONS[from].filter((to) => !(from === 'DRAFT' && to === 'PENDING_PAYMENT'));
}

const fullName = (p: { firstName: string; lastName: string } | null): string | null => (p ? `${p.firstName} ${p.lastName}` : null);

@Injectable()
export class AdminBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly audit: AuditService,
    private readonly mail: MailerService,
    private readonly enc: FieldEncryption,
    private readonly money: MoneyService,
  ) {}

  async list(q: AdminBookingQuery): Promise<Paginated<AdminBookingRowDto>> {
    const and: Prisma.BookingWhereInput[] = [{ deletedAt: null }];
    if (q.status) and.push({ status: q.status });
    if (q.paymentStatus) and.push({ paymentStatus: q.paymentStatus });
    if (q.assignedToId) and.push(q.assignedToId === 'none' ? { assignedToId: null } : { assignedToId: q.assignedToId });
    if (q.departureFrom || q.departureTo) {
      and.push({
        departure: {
          departureDate: {
            ...(q.departureFrom ? { gte: new Date(`${q.departureFrom}T00:00:00Z`) } : {}),
            ...(q.departureTo ? { lte: new Date(`${q.departureTo}T00:00:00Z`) } : {}),
          },
        },
      });
    }
    if (q.q) {
      const contains = { contains: q.q, mode: 'insensitive' as const };
      and.push({ OR: [{ reference: contains }, { customer: { OR: [{ firstName: contains }, { lastName: contains }, { email: contains }, { phone: contains }] } }, { package: { title: contains } }] });
    }
    const where: Prisma.BookingWhereInput = { AND: and };
    const total = await this.prisma.booking.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pageCount);
    const rows = await this.prisma.booking.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * q.pageSize,
      take: q.pageSize,
      include: adminInclude,
    });
    return { items: rows.map((r) => this.row(r)), meta: { total, page, pageSize: q.pageSize, pageCount } };
  }

  async get(id: string): Promise<AdminBookingDetailDto> {
    return this.detail(await this.load(id));
  }

  async changeStatus(user: AuthUser, id: string, input: BookingStatusChangeInput, ctx: ClientContext): Promise<AdminBookingDetailDto> {
    const booking = await this.load(id);
    const from = booking.status as BookingStatusKey;
    const to = input.toStatus;
    if (from === to) throw new ConflictException({ message: 'The booking is already in that status.', code: 'no_change' });
    if (!canTransitionBooking(from, to) || !staffTransitions(from).includes(to)) {
      throw new UnprocessableEntityException({ message: `A booking cannot move from ${from} to ${to}.`, code: 'invalid_transition' });
    }
    if (to === 'CANCELLED') {
      if (!user.permissions.has('bookings:cancel')) throw new ForbiddenException({ message: 'You do not have permission to cancel bookings.', code: 'forbidden' });
      if (!input.note) throw new UnprocessableEntityException({ message: 'Give a reason for the cancellation.', code: 'note_required' });
    } else if (!user.permissions.has('bookings:update')) {
      throw new ForbiddenException({ message: 'You do not have permission to update bookings.', code: 'forbidden' });
    }

    const now = new Date();
    const data: Prisma.BookingUpdateManyMutationInput = { status: to };
    if (to === 'CONFIRMED') data.confirmedAt = now;
    if (to === 'COMPLETED') data.completedAt = now;
    if (to === 'CANCELLED') {
      data.cancelledAt = now;
      data.cancellationReason = input.note;
      data.seatHoldExpiresAt = null;
    }

    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.booking.updateMany({ where: { id, status: from }, data });
      if (moved.count !== 1) throw new ConflictException({ message: 'Someone else just changed this booking. Refresh and try again.', code: 'conflict' });
      if (to === 'CANCELLED') {
        await this.bookings.releaseSeats(tx, booking.departureId, booking.adults + booking.children);
        // Money already received stays on record as "refund pending" until finance returns it.
        await this.money.sync(tx, id);
      }
      await tx.bookingStatusHistory.create({ data: { bookingId: id, fromStatus: from, toStatus: to, changedById: user.id, note: input.note ?? null } });
      await this.audit.record({ action: 'booking.status_changed', entityType: 'Booking', entityId: id, actorUserId: user.id, before: { status: from }, after: { status: to }, metadata: { note: input.note, reference: booking.reference }, ...ctx }, tx);
    });

    if (to === 'CONFIRMED' && booking.customer.email) {
      void this.mail.sendTemplate(
        'booking.confirmed',
        booking.customer.email,
        { firstName: booking.customer.firstName, reference: booking.reference, balanceDue: `${booking.currency} ${booking.balanceDue.toString()}`, balanceDueDate: ymd(booking.balanceDueDate) ?? '' },
        { customerId: booking.customerId },
      );
    }
    return this.get(id);
  }

  async assign(user: AuthUser, id: string, assignedToId: string | null, ctx: ClientContext): Promise<AdminBookingDetailDto> {
    const booking = await this.load(id);
    if (assignedToId) {
      const staff = await this.prisma.user.findFirst({ where: { id: assignedToId, type: 'STAFF', status: 'ACTIVE', deletedAt: null }, select: { id: true } });
      if (!staff) throw new UnprocessableEntityException({ message: 'Choose an active staff member.', code: 'invalid_assignee' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({ where: { id }, data: { assignedToId } });
      await this.audit.record({ action: 'booking.assigned', entityType: 'Booking', entityId: id, actorUserId: user.id, before: { assignedToId: booking.assignedToId }, after: { assignedToId }, ...ctx }, tx);
    });
    return this.get(id);
  }

  async addNote(user: AuthUser, id: string, body: string, ctx: ClientContext): Promise<AdminBookingDetailDto> {
    await this.load(id);
    await this.prisma.$transaction(async (tx) => {
      const note = await tx.crmNote.create({ data: { bookingId: id, authorId: user.id, body } });
      await this.audit.record({ action: 'booking.note_added', entityType: 'Booking', entityId: id, actorUserId: user.id, metadata: { noteId: note.id }, ...ctx }, tx);
    });
    return this.get(id);
  }

  /** Active staff who can be given a booking. */
  async assignees(): Promise<{ id: string; name: string }[]> {
    const rows = await this.prisma.user.findMany({
      where: { type: 'STAFF', status: 'ACTIVE', deletedAt: null, roles: { some: { role: { permissions: { some: { permission: { key: 'bookings:read' } } } } } } },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: { id: true, firstName: true, lastName: true },
    });
    return rows.map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}` }));
  }

  /* ------------------------------ internals ------------------------------ */

  private async load(id: string): Promise<AdminBookingRow> {
    const row = await this.prisma.booking.findFirst({ where: { id, deletedAt: null }, include: adminInclude });
    if (!row) throw new NotFoundException({ message: 'Booking not found.', code: 'not_found' });
    return row;
  }

  private row(b: AdminBookingRow): AdminBookingRowDto {
    return {
      ...this.bookings.summary(b as BookingRow),
      customerId: b.customerId,
      customerName: `${b.customer.firstName} ${b.customer.lastName}`,
      customerEmail: b.customer.email,
      assignedToName: fullName(b.assignedTo),
      source: b.source,
    };
  }

  private detail(b: AdminBookingRow): AdminBookingDetailDto {
    const { canCancel: _canCancel, ...base } = this.bookings.detail(b as BookingRow);
    const notes: NoteDto[] = b.notes.map((n) => ({ id: n.id, body: n.body, authorName: fullName(n.author), createdAt: n.createdAt.toISOString() }));
    const roomIndex = new Map(b.rooms.map((r, i) => [r.id, i]));
    return {
      ...base,
      customer: { id: b.customer.id, name: `${b.customer.firstName} ${b.customer.lastName}`, email: b.customer.email, phone: b.customer.phone, whatsappNumber: b.customer.whatsappNumber },
      assignedToId: b.assignedToId,
      assignedToName: fullName(b.assignedTo),
      source: b.source,
      notes,
      allowedTransitions: staffTransitions(b.status as BookingStatusKey),
      staffTravelers: b.travelers.map((bt) => ({
        ...travelerToDto(bt.traveler, this.enc),
        kind: bt.travelerType,
        roomIndex: bt.bookingRoomId ? (roomIndex.get(bt.bookingRoomId) ?? null) : null,
        isLead: bt.isLeadTraveler,
      })),
    };
  }
}
