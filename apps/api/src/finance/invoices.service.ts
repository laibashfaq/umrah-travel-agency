import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { fromMinor, toMinor, type InvoiceDto, type Paginated, type Quote } from '@umrah/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { ClientContext } from '../common/http/request-context';
import { ReferenceService } from '../common/references.service';
import type { Prisma } from '../generated/prisma/client';
import { requireCustomerId, ymd } from '../modules/portal/portal.util';
import { PrismaService } from '../prisma/prisma.service';
import { MoneyService } from './money.service';

type Tx = Prisma.TransactionClient;
const include = {
  lines: { orderBy: { sortOrder: 'asc' } },
  booking: { select: { reference: true } },
  customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
} satisfies Prisma.InvoiceInclude;
type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof include }>;

const KIND_LABEL = { adult: 'adult', child: 'child', infant: 'infant' } as const;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: ReferenceService,
    private readonly money: MoneyService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Issues the invoice for a submitted booking. One live invoice per booking: calling it again returns the existing one.
   * Lines come from the room plan priced when the booking was made, so they always add up to the booking total.
   */
  async issueForBooking(tx: Tx, bookingId: string, issuedById: string | null): Promise<string> {
    const existing = await tx.invoice.findFirst({ where: { bookingId, status: { not: 'VOID' } }, select: { id: true } });
    if (existing) return existing.id;
    const b = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { customerId: true, currency: true, subtotal: true, discountTotal: true, taxTotal: true, grandTotal: true, balanceDueDate: true, pricingSnapshot: true, package: { select: { title: true } }, departure: { select: { departureDate: true } } },
    });
    const quote = (b.pricingSnapshot as { quote?: Quote } | null)?.quote;
    const lines: { description: string; quantity: number; unitPrice: string; total: string }[] = [];
    for (const [i, room] of (quote?.rooms ?? []).entries()) {
      for (const [kind, count, unit] of [['adult', room.adults, room.adultPrice], ['child', room.children, room.childPrice], ['infant', room.infants, room.infantPrice]] as const) {
        if (count > 0) lines.push({ description: `${b.package.title}: room ${i + 1} (${room.occupancy.toLowerCase()}), ${KIND_LABEL[kind]}`, quantity: count, unitPrice: unit, total: fromMinor(count * toMinor(unit)) });
      }
    }
    const linesTotal = lines.reduce((n, l) => n + toMinor(l.total), 0);
    // If the stored plan does not reproduce the total, bill one line for the package rather than a wrong breakdown.
    if (lines.length === 0 || linesTotal !== toMinor(b.subtotal.toString())) {
      lines.splice(0, lines.length, { description: b.package.title, quantity: 1, unitPrice: fromMinor(toMinor(b.subtotal.toString())), total: fromMinor(toMinor(b.subtotal.toString())) });
    }
    const number = await this.refs.next('INV', tx);
    const total = fromMinor(toMinor(b.grandTotal.toString()));
    const invoice = await tx.invoice.create({
      data: {
        number,
        bookingId,
        customerId: b.customerId,
        status: 'ISSUED',
        currency: b.currency,
        issueDate: new Date(),
        dueDate: b.balanceDueDate,
        subtotal: fromMinor(toMinor(b.subtotal.toString())),
        discountTotal: b.discountTotal,
        taxTotal: b.taxTotal,
        total,
        balanceDue: total,
        issuedById,
        lines: { create: lines.map((l, sortOrder) => ({ ...l, sortOrder })) },
      },
    });
    await this.audit.record({ action: 'invoice.issued', entityType: 'Invoice', entityId: invoice.id, actorUserId: issuedById, actorType: issuedById ? 'USER' : 'SYSTEM', metadata: { number, bookingId, total } }, tx);
    await this.money.sync(tx, bookingId);
    return invoice.id;
  }

  async issueManually(user: AuthUser, bookingId: string, ctx: ClientContext): Promise<InvoiceDto> {
    const b = await this.prisma.booking.findFirst({ where: { id: bookingId, deletedAt: null }, select: { status: true } });
    if (!b) throw new NotFoundException({ message: 'Booking not found.', code: 'not_found' });
    if (b.status === 'DRAFT' || b.status === 'CANCELLED') throw new ConflictException({ message: 'Only submitted bookings are invoiced.', code: 'not_invoiceable' });
    const id = await this.prisma.$transaction(async (tx) => {
      const issued = await this.issueForBooking(tx, bookingId, user.id);
      await this.audit.record({ action: 'invoice.requested', entityType: 'Booking', entityId: bookingId, actorUserId: user.id, ...ctx }, tx);
      return issued;
    });
    return this.get(id);
  }

  async void(user: AuthUser, id: string, reason: string, ctx: ClientContext): Promise<InvoiceDto> {
    const inv = await this.prisma.invoice.findUnique({ where: { id }, select: { bookingId: true } });
    if (!inv) throw new NotFoundException({ message: 'Invoice not found.', code: 'not_found' });
    await this.prisma.$transaction(async (tx) => {
      await this.money.lock(tx, inv.bookingId);
      const current = await tx.invoice.findUniqueOrThrow({ where: { id } });
      if (current.status === 'VOID') throw new ConflictException({ message: 'This invoice is already void.', code: 'already_void' });
      if (toMinor(current.amountPaid.toString()) > 0) throw new ConflictException({ message: 'An invoice with payments against it cannot be voided. Refund the payments first.', code: 'has_payments' });
      await tx.invoice.update({ where: { id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: reason } });
      await this.audit.record({ action: 'invoice.voided', entityType: 'Invoice', entityId: id, actorUserId: user.id, metadata: { reason, number: current.number }, ...ctx }, tx);
    });
    return this.get(id);
  }

  async list(q: { q?: string; status?: string; page: number; pageSize: number }): Promise<Paginated<InvoiceDto>> {
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : null;
    const where: Prisma.InvoiceWhereInput = {
      ...(q.status ? { status: q.status as 'ISSUED' } : {}),
      ...(contains ? { OR: [{ number: contains }, { booking: { reference: contains } }, { customer: { OR: [{ firstName: contains }, { lastName: contains }, { email: contains }] } }] } : {}),
    };
    const total = await this.prisma.invoice.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pageCount);
    const rows = await this.prisma.invoice.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * q.pageSize, take: q.pageSize, include });
    return { items: rows.map((r) => this.dto(r)), meta: { total, page, pageSize: q.pageSize, pageCount } };
  }

  async forBooking(bookingId: string): Promise<InvoiceDto[]> {
    const rows = await this.prisma.invoice.findMany({ where: { bookingId }, orderBy: { createdAt: 'desc' }, include });
    return rows.map((r) => this.dto(r));
  }

  async get(id: string): Promise<InvoiceDto> {
    const row = await this.prisma.invoice.findUnique({ where: { id }, include });
    if (!row) throw new NotFoundException({ message: 'Invoice not found.', code: 'not_found' });
    return this.dto(row);
  }

  async listMine(user: AuthUser): Promise<InvoiceDto[]> {
    const rows = await this.prisma.invoice.findMany({ where: { customerId: requireCustomerId(user), status: { not: 'DRAFT' } }, orderBy: { createdAt: 'desc' }, take: 100, include });
    return rows.map((r) => this.dto(r));
  }

  async getMine(user: AuthUser, id: string): Promise<InvoiceDto> {
    const row = await this.prisma.invoice.findFirst({ where: { id, customerId: requireCustomerId(user), status: { not: 'DRAFT' } }, include });
    if (!row) throw new NotFoundException({ message: 'Invoice not found.', code: 'not_found' });
    return this.dto(row);
  }

  private dto(r: InvoiceRow): InvoiceDto {
    const m = (v: { toString(): string }) => fromMinor(toMinor(v.toString()));
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      bookingId: r.bookingId,
      bookingReference: r.booking.reference,
      currency: r.currency,
      issueDate: ymd(r.issueDate),
      dueDate: ymd(r.dueDate),
      subtotal: m(r.subtotal),
      discountTotal: m(r.discountTotal),
      taxTotal: m(r.taxTotal),
      total: m(r.total),
      amountPaid: m(r.amountPaid),
      balanceDue: m(r.balanceDue),
      notes: r.notes,
      voidReason: r.voidReason,
      customer: { name: `${r.customer.firstName} ${r.customer.lastName}`, email: r.customer.email, phone: r.customer.phone },
      lines: r.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: m(l.unitPrice), total: m(l.total) })),
    };
  }
}
