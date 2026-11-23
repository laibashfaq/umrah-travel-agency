import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  fromMinor,
  purposeFor,
  toMinor,
  type BookingMoneyDto,
  type Paginated,
  type PaymentDto,
  type RecordPaymentInput,
  type ReportPaymentInput,
  type VerifyPaymentInput,
} from '@umrah/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { ClientContext } from '../common/http/request-context';
import { ReferenceService } from '../common/references.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { MailerService } from '../mail/mailer.service';
import { asDate, requireCustomerId, ymd } from '../modules/portal/portal.util';
import { PrismaService } from '../prisma/prisma.service';
import { MoneyService } from './money.service';

const include = {
  booking: { select: { reference: true } },
  customer: { select: { firstName: true, lastName: true } },
  recordedBy: { select: { firstName: true, lastName: true } },
  verifiedBy: { select: { firstName: true, lastName: true } },
  refunds: { where: { status: 'COMPLETED' }, select: { amount: true } },
} satisfies Prisma.PaymentInclude;
type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof include }>;

/** Bookings that can still receive money: submitted and not finished or cancelled. */
const PAYABLE = ['PENDING_PAYMENT', 'CONFIRMED', 'VISA_PROCESSING', 'TRAVEL_PREPARATION'] as const;

const name = (p: { firstName: string; lastName: string } | null) => (p ? `${p.firstName} ${p.lastName}` : null);

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly money: MoneyService,
    private readonly refs: ReferenceService,
    private readonly audit: AuditService,
    private readonly mail: MailerService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /* ------------------------------- customer ------------------------------- */

  async bookingMoney(user: AuthUser, bookingId: string): Promise<BookingMoneyDto> {
    const customerId = requireCustomerId(user);
    const own = await this.prisma.booking.findFirst({ where: { id: bookingId, customerId, deletedAt: null }, select: { id: true } });
    if (!own) throw new NotFoundException({ message: 'Booking not found.', code: 'not_found' });
    return this.money.summary(this.prisma, bookingId);
  }

  async listMine(user: AuthUser): Promise<PaymentDto[]> {
    const rows = await this.prisma.payment.findMany({ where: { customerId: requireCustomerId(user) }, orderBy: { createdAt: 'desc' }, take: 200, include });
    return rows.map((r) => this.dto(r));
  }

  async getMine(user: AuthUser, id: string): Promise<PaymentDto> {
    const row = await this.prisma.payment.findFirst({ where: { id, customerId: requireCustomerId(user) }, include });
    if (!row) throw new NotFoundException({ message: 'Payment not found.', code: 'not_found' });
    return this.dto(row);
  }

  /** The customer says they have paid. Finance checks the bank before it counts. */
  async report(user: AuthUser, input: ReportPaymentInput, ctx: ClientContext): Promise<PaymentDto> {
    const customerId = requireCustomerId(user);
    const booking = await this.prisma.booking.findFirst({ where: { id: input.bookingId, customerId, deletedAt: null }, select: { id: true } });
    if (!booking) throw new NotFoundException({ message: 'Booking not found.', code: 'not_found' });
    return this.create({ actorId: user.id, customerSide: true, verifyNow: false }, input, ctx);
  }

  /* --------------------------------- staff --------------------------------- */

  /** Staff records money received. With payments:verify it counts straight away; without, it waits for a finance check. */
  async record(user: AuthUser, input: RecordPaymentInput, ctx: ClientContext): Promise<PaymentDto> {
    const exists = await this.prisma.booking.findFirst({ where: { id: input.bookingId, deletedAt: null }, select: { id: true } });
    if (!exists) throw new NotFoundException({ message: 'Booking not found.', code: 'not_found' });
    return this.create({ actorId: user.id, customerSide: false, verifyNow: user.permissions.has('payments:verify') }, input, ctx);
  }

  async verify(user: AuthUser, id: string, input: VerifyPaymentInput, ctx: ClientContext): Promise<PaymentDto> {
    const found = await this.prisma.payment.findUnique({ where: { id }, select: { bookingId: true } });
    if (!found) throw new NotFoundException({ message: 'Payment not found.', code: 'not_found' });

    const outcome = await this.prisma.$transaction(async (tx) => {
      await this.money.lock(tx, found.bookingId);
      const p = await tx.payment.findUniqueOrThrow({ where: { id }, include: { booking: { select: { status: true, grandTotal: true, reference: true, customerId: true, currency: true } } } });
      if (p.status !== 'AWAITING_VERIFICATION') throw new ConflictException({ message: 'This payment has already been checked.', code: 'already_decided' });
      // Four eyes: the person who entered a payment cannot be the one who confirms it.
      if (p.recordedById === user.id) throw new ConflictException({ message: 'Someone else must verify a payment you recorded.', code: 'same_person' });

      if (input.decision === 'REJECT') {
        await tx.payment.update({ where: { id }, data: { status: 'FAILED', failureMessage: input.note, verifiedById: user.id, verifiedAt: new Date() } });
        await this.audit.record({ action: 'payment.rejected', entityType: 'Payment', entityId: id, actorUserId: user.id, metadata: { reason: input.note, reference: p.reference }, ...ctx }, tx);
        return { confirmed: false, bookingId: p.bookingId, autoConfirmed: false };
      }

      const t = await this.money.totals(tx, p.bookingId);
      if (t.received - t.refunded + toMinor(p.amount.toString()) > toMinor(p.booking.grandTotal.toString())) {
        throw new UnprocessableEntityException({ message: 'Accepting this payment would take the booking above its total.', code: 'overpayment' });
      }
      await tx.payment.update({ where: { id }, data: { status: 'SUCCESSFUL', verifiedById: user.id, verifiedAt: new Date(), receivedAt: p.receivedAt ?? new Date() } });
      const autoConfirmed = await this.afterMoneyIn(tx, p.bookingId, user.id);
      await this.audit.record({ action: 'payment.verified', entityType: 'Payment', entityId: id, actorUserId: user.id, metadata: { reference: p.reference, amount: p.amount.toString(), autoConfirmed }, ...ctx }, tx);
      return { confirmed: true, bookingId: p.bookingId, autoConfirmed };
    });

    if (outcome.autoConfirmed) await this.sendConfirmed(outcome.bookingId);
    return this.get(id);
  }

  async list(q: { q?: string; status?: string; bookingId?: string; page: number; pageSize: number }): Promise<Paginated<PaymentDto>> {
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : null;
    const where: Prisma.PaymentWhereInput = {
      ...(q.status ? { status: q.status as 'PENDING' } : {}),
      ...(q.bookingId ? { bookingId: q.bookingId } : {}),
      ...(contains ? { OR: [{ reference: contains }, { booking: { reference: contains } }, { customer: { OR: [{ firstName: contains }, { lastName: contains }, { email: contains }] } }] } : {}),
    };
    const total = await this.prisma.payment.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pageCount);
    const rows = await this.prisma.payment.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (page - 1) * q.pageSize, take: q.pageSize, include });
    return { items: rows.map((r) => this.dto(r)), meta: { total, page, pageSize: q.pageSize, pageCount } };
  }

  async get(id: string): Promise<PaymentDto> {
    const row = await this.prisma.payment.findUnique({ where: { id }, include });
    if (!row) throw new NotFoundException({ message: 'Payment not found.', code: 'not_found' });
    return this.dto(row);
  }

  /* ------------------------------- internals ------------------------------- */

  private async create(who: { actorId: string; customerSide: boolean; verifyNow: boolean }, input: ReportPaymentInput | RecordPaymentInput, ctx: ClientContext): Promise<PaymentDto> {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.money.lock(tx, input.bookingId);
      const b = await tx.booking.findUniqueOrThrow({ where: { id: input.bookingId }, select: { status: true, grandTotal: true, depositAmount: true, currency: true, customerId: true, reference: true } });
      if (!(PAYABLE as readonly string[]).includes(b.status)) {
        throw new ConflictException({ message: b.status === 'DRAFT' ? 'Submit the booking before paying.' : 'This booking can no longer take payments.', code: 'not_payable' });
      }
      const t = await this.money.totals(tx, input.bookingId);
      const net = t.received - t.refunded;
      const room = toMinor(b.grandTotal.toString()) - net - t.pendingClaims;
      const amount = toMinor(input.amount);
      if (amount > room) {
        throw new UnprocessableEntityException({
          message: room <= 0 ? 'Nothing more is due on this booking (payments awaiting a check are counted).' : `That is more than the amount still due (${b.currency} ${fromMinor(room)}).`,
          code: 'overpayment',
          errors: [{ field: 'amount', message: `At most ${fromMinor(room)}` }],
        });
      }
      if (input.transactionRef) {
        const dup = await tx.payment.findFirst({ where: { bookingId: input.bookingId, status: { in: ['AWAITING_VERIFICATION', 'SUCCESSFUL'] }, metadata: { path: ['transactionRef'], equals: input.transactionRef } }, select: { reference: true } });
        if (dup) throw new ConflictException({ message: `A payment with that transaction reference is already on file (${dup.reference}).`, code: 'duplicate_payment' });
      }
      const purpose = purposeFor(input.amount, { grandTotal: b.grandTotal.toString(), depositAmount: b.depositAmount.toString(), net: fromMinor(net) });
      const reference = await this.refs.next('PAY', tx);
      const created = await tx.payment.create({
        data: {
          reference,
          bookingId: input.bookingId,
          customerId: b.customerId,
          method: input.method,
          purpose,
          status: who.verifyNow ? 'SUCCESSFUL' : 'AWAITING_VERIFICATION',
          amount: input.amount,
          currency: b.currency,
          provider: 'manual',
          receivedAt: asDate(input.paidOn),
          recordedById: who.actorId,
          ...(who.verifyNow ? { verifiedById: who.actorId, verifiedAt: new Date() } : {}),
          metadata: { transactionRef: input.transactionRef ?? null, note: input.note ?? null, reportedBy: who.customerSide ? 'customer' : 'staff' },
        },
      });
      let autoConfirmed = false;
      if (who.verifyNow) autoConfirmed = await this.afterMoneyIn(tx, input.bookingId, who.actorId);
      await this.audit.record({ action: who.customerSide ? 'payment.reported' : who.verifyNow ? 'payment.recorded_verified' : 'payment.recorded', entityType: 'Payment', entityId: created.id, actorUserId: who.actorId, after: { reference, amount: input.amount, method: input.method, bookingId: input.bookingId }, ...ctx }, tx);
      return { id: created.id, autoConfirmed };
    });
    if (result.autoConfirmed) await this.sendConfirmed(input.bookingId);
    return this.get(result.id);
  }

  /** Recomputes the booking after money arrived and confirms it when the deposit is covered. */
  private async afterMoneyIn(tx: Prisma.TransactionClient, bookingId: string, actorId: string): Promise<boolean> {
    const pos = await this.money.sync(tx, bookingId);
    if (pos.paymentStatus !== 'DEPOSIT_PAID' && pos.paymentStatus !== 'PAID') return false;
    const moved = await tx.booking.updateMany({ where: { id: bookingId, status: 'PENDING_PAYMENT' }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });
    if (moved.count !== 1) return false;
    await tx.bookingStatusHistory.create({ data: { bookingId, fromStatus: 'PENDING_PAYMENT', toStatus: 'CONFIRMED', changedById: actorId, note: 'Deposit received' } });
    await this.audit.record({ action: 'booking.auto_confirmed', entityType: 'Booking', entityId: bookingId, actorUserId: actorId, metadata: { reason: 'deposit_received' } }, tx);
    return true;
  }

  private async sendConfirmed(bookingId: string) {
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { reference: true, currency: true, balanceDue: true, balanceDueDate: true, customerId: true, customer: { select: { firstName: true, email: true } } } });
    if (!b?.customer.email) return;
    void this.mail.sendTemplate('booking.confirmed', b.customer.email, { firstName: b.customer.firstName, reference: b.reference, balanceDue: `${b.currency} ${fromMinor(toMinor(b.balanceDue.toString()))}`, balanceDueDate: ymd(b.balanceDueDate) ?? '' }, { customerId: b.customerId });
  }

  private dto(r: PaymentRow): PaymentDto {
    const meta = (r.metadata ?? {}) as { transactionRef?: string | null; note?: string | null };
    return {
      id: r.id,
      reference: r.reference,
      bookingId: r.bookingId,
      bookingReference: r.booking.reference,
      customerName: `${r.customer.firstName} ${r.customer.lastName}`,
      method: r.method,
      purpose: r.purpose,
      status: r.status,
      amount: fromMinor(toMinor(r.amount.toString())),
      currency: r.currency,
      paidOn: ymd(r.receivedAt),
      transactionRef: meta.transactionRef ?? null,
      note: meta.note ?? null,
      failureMessage: r.failureMessage,
      recordedByName: name(r.recordedBy),
      verifiedByName: name(r.verifiedBy),
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      refundedAmount: fromMinor(r.refunds.reduce((n, x) => n + toMinor(x.amount.toString()), 0)),
      createdAt: r.createdAt.toISOString(),
    };
  }
}
