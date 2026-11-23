import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { fromMinor, toMinor, type Paginated, type RefundActionInput, type RefundDto, type RequestRefundInput } from '@umrah/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { ClientContext } from '../common/http/request-context';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MoneyService } from './money.service';

const include = {
  payment: { select: { reference: true, amount: true } },
  booking: { select: { reference: true, customer: { select: { firstName: true, lastName: true } } } },
  requestedBy: { select: { firstName: true, lastName: true } },
  approvedBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.RefundInclude;
type RefundRow = Prisma.RefundGetPayload<{ include: typeof include }>;

const name = (p: { firstName: string; lastName: string } | null) => (p ? `${p.firstName} ${p.lastName}` : null);
/** Refunds that still count against what can be refunded from a payment. */
const OPEN_OR_DONE = ['REQUESTED', 'APPROVED', 'PROCESSING', 'COMPLETED'] as const;

@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly money: MoneyService,
    private readonly audit: AuditService,
  ) {}

  async list(q: { status?: string; page: number; pageSize: number }): Promise<Paginated<RefundDto>> {
    const where: Prisma.RefundWhereInput = q.status ? { status: q.status as 'REQUESTED' } : {};
    const total = await this.prisma.refund.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pageCount);
    const rows = await this.prisma.refund.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * q.pageSize, take: q.pageSize, include });
    return { items: rows.map((r) => this.dto(r)), meta: { total, page, pageSize: q.pageSize, pageCount } };
  }

  async forBooking(bookingId: string): Promise<RefundDto[]> {
    const rows = await this.prisma.refund.findMany({ where: { bookingId }, orderBy: { createdAt: 'desc' }, include });
    return rows.map((r) => this.dto(r));
  }

  async request(user: AuthUser, input: RequestRefundInput, ctx: ClientContext): Promise<RefundDto> {
    const payment = await this.prisma.payment.findUnique({ where: { id: input.paymentId }, select: { bookingId: true } });
    if (!payment) throw new NotFoundException({ message: 'Payment not found.', code: 'not_found' });
    const id = await this.prisma.$transaction(async (tx) => {
      await this.money.lock(tx, payment.bookingId);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId } });
      if (p.status !== 'SUCCESSFUL' && p.status !== 'PARTIALLY_REFUNDED') {
        throw new ConflictException({ message: 'Only payments that were received can be refunded.', code: 'not_refundable' });
      }
      const claimed = await tx.refund.aggregate({ where: { paymentId: p.id, status: { in: [...OPEN_OR_DONE] } }, _sum: { amount: true } });
      const room = toMinor(p.amount.toString()) - toMinor(claimed._sum.amount?.toString() ?? '0');
      if (toMinor(input.amount) > room) {
        throw new UnprocessableEntityException({ message: room <= 0 ? 'This payment has already been refunded in full.' : `At most ${p.currency} ${fromMinor(room)} can still be refunded from this payment.`, code: 'over_refund', errors: [{ field: 'amount', message: `At most ${fromMinor(room)}` }] });
      }
      const created = await tx.refund.create({
        data: { paymentId: p.id, bookingId: p.bookingId, amount: input.amount, currency: p.currency, reason: input.reason, requestedById: user.id },
      });
      await this.audit.record({ action: 'refund.requested', entityType: 'Refund', entityId: created.id, actorUserId: user.id, after: { paymentId: p.id, amount: input.amount, reason: input.reason }, ...ctx }, tx);
      return created.id;
    });
    return this.get(id);
  }

  async act(user: AuthUser, id: string, input: RefundActionInput, ctx: ClientContext): Promise<RefundDto> {
    const found = await this.prisma.refund.findUnique({ where: { id }, select: { bookingId: true } });
    if (!found) throw new NotFoundException({ message: 'Refund not found.', code: 'not_found' });
    await this.prisma.$transaction(async (tx) => {
      await this.money.lock(tx, found.bookingId);
      const r = await tx.refund.findUniqueOrThrow({ where: { id } });
      const bad = (message: string) => new ConflictException({ message, code: 'invalid_state' });

      if (input.action === 'approve' || input.action === 'reject') {
        if (r.status !== 'REQUESTED') throw bad('This refund has already been decided.');
        // Four eyes: whoever asked for a refund cannot approve it.
        if (input.action === 'approve' && r.requestedById === user.id) throw new ConflictException({ message: 'Someone else must approve a refund you requested.', code: 'same_person' });
        await tx.refund.update({ where: { id }, data: input.action === 'approve' ? { status: 'APPROVED', approvedById: user.id } : { status: 'REJECTED', approvedById: user.id, failureMessage: input.note } });
      } else {
        if (r.status !== 'APPROVED') throw bad('Only an approved refund can be marked as paid or failed.');
        if (input.action === 'complete') {
          await tx.refund.update({ where: { id }, data: { status: 'COMPLETED', processedAt: new Date(), providerRefundId: input.note ?? null } });
          const done = await tx.refund.aggregate({ where: { paymentId: r.paymentId, status: 'COMPLETED' }, _sum: { amount: true } });
          const pay = await tx.payment.findUniqueOrThrow({ where: { id: r.paymentId }, select: { amount: true } });
          const full = toMinor(done._sum.amount?.toString() ?? '0') >= toMinor(pay.amount.toString());
          await tx.payment.update({ where: { id: r.paymentId }, data: { status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
          await this.money.sync(tx, r.bookingId);
        } else {
          await tx.refund.update({ where: { id }, data: { status: 'FAILED', failureMessage: input.note } });
        }
      }
      await this.audit.record({ action: `refund.${input.action}`, entityType: 'Refund', entityId: id, actorUserId: user.id, before: { status: r.status }, metadata: { note: input.note, amount: r.amount.toString() }, ...ctx }, tx);
    });
    return this.get(id);
  }

  async get(id: string): Promise<RefundDto> {
    const row = await this.prisma.refund.findUnique({ where: { id }, include });
    if (!row) throw new NotFoundException({ message: 'Refund not found.', code: 'not_found' });
    return this.dto(row);
  }

  private dto(r: RefundRow): RefundDto {
    return {
      id: r.id,
      paymentId: r.paymentId,
      paymentReference: r.payment.reference,
      bookingId: r.bookingId,
      bookingReference: r.booking.reference,
      customerName: `${r.booking.customer.firstName} ${r.booking.customer.lastName}`,
      amount: fromMinor(toMinor(r.amount.toString())),
      currency: r.currency,
      reason: r.reason,
      status: r.status,
      requestedByName: name(r.requestedBy),
      approvedByName: name(r.approvedBy),
      processedAt: r.processedAt?.toISOString() ?? null,
      failureMessage: r.failureMessage,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
