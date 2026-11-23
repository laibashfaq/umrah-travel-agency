import { Injectable } from '@nestjs/common';
import { fromMinor, moneyPosition, toMinor, type BookingMoneyDto } from '@umrah/shared';
import type { Prisma } from '../generated/prisma/client';
import { SettingsService } from '../settings/settings.service';

type Tx = Prisma.TransactionClient;

/**
 * Keeps a booking's money fields (paid, refunded, balance, payment status) and its invoice in line with the
 * individual payment and refund records. Everything is recomputed from those records, never incremented, so
 * running it twice or in any order gives the same answer.
 */
@Injectable()
export class MoneyService {
  constructor(private readonly settings: SettingsService) {}

  /** Locks the booking row so concurrent payment decisions on one booking are applied one at a time. */
  async lock(tx: Tx, bookingId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
  }

  async totals(tx: Tx, bookingId: string): Promise<{ received: number; refunded: number; pendingClaims: number }> {
    const [paid, refunds, pending] = await Promise.all([
      tx.payment.aggregate({ where: { bookingId, status: { in: ['SUCCESSFUL', 'REFUNDED', 'PARTIALLY_REFUNDED'] } }, _sum: { amount: true } }),
      tx.refund.aggregate({ where: { bookingId, status: 'COMPLETED' }, _sum: { amount: true } }),
      tx.payment.aggregate({ where: { bookingId, status: { in: ['AWAITING_VERIFICATION', 'PENDING'] } }, _sum: { amount: true } }),
    ]);
    return {
      received: toMinor(paid._sum.amount?.toString() ?? '0'),
      refunded: toMinor(refunds._sum.amount?.toString() ?? '0'),
      pendingClaims: toMinor(pending._sum.amount?.toString() ?? '0'),
    };
  }

  /** Recomputes the booking (and its invoice) from the records. Call inside the transaction that changed them. */
  async sync(tx: Tx, bookingId: string) {
    const b = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { grandTotal: true, depositAmount: true, status: true } });
    const t = await this.totals(tx, bookingId);
    const pos = moneyPosition({
      grandTotal: b.grandTotal.toString(),
      depositAmount: b.depositAmount.toString(),
      cancelled: b.status === 'CANCELLED',
      received: fromMinor(t.received),
      refunded: fromMinor(t.refunded),
    });
    await tx.booking.update({
      where: { id: bookingId },
      data: { amountPaid: fromMinor(t.received), amountRefunded: fromMinor(t.refunded), balanceDue: pos.balanceDue, paymentStatus: pos.paymentStatus },
    });

    // The live invoice mirrors what has been paid.
    const invoice = await tx.invoice.findFirst({ where: { bookingId, status: { not: 'VOID' } }, orderBy: { createdAt: 'desc' } });
    if (invoice) {
      const net = toMinor(pos.net);
      const total = toMinor(invoice.total.toString());
      if (b.status === 'CANCELLED' && t.received === 0) {
        // Nothing was ever paid on a cancelled booking: the invoice is simply cancelled.
        await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: 'Booking cancelled', balanceDue: '0.00' } });
      } else {
        const status = b.status === 'CANCELLED' ? (net === 0 ? 'REFUNDED' : invoice.status) : net >= total ? 'PAID' : net > 0 ? 'PARTIALLY_PAID' : 'ISSUED';
        await tx.invoice.update({ where: { id: invoice.id }, data: { amountPaid: fromMinor(net), balanceDue: b.status === 'CANCELLED' ? '0.00' : fromMinor(Math.max(0, total - net)), status } });
      }
    }
    return { ...pos, received: t.received, refunded: t.refunded, pendingClaims: t.pendingClaims };
  }

  /** The money picture shown to a customer or staff member. */
  async summary(tx: Pick<Prisma.TransactionClient, 'booking' | 'payment' | 'refund'>, bookingId: string): Promise<BookingMoneyDto> {
    const b = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { grandTotal: true, depositAmount: true, currency: true, status: true } });
    const t = await this.totals(tx as Tx, bookingId);
    const pos = moneyPosition({
      grandTotal: b.grandTotal.toString(),
      depositAmount: b.depositAmount.toString(),
      cancelled: b.status === 'CANCELLED',
      received: fromMinor(t.received),
      refunded: fromMinor(t.refunded),
    });
    const payable = b.status === 'CANCELLED' ? 0 : Math.max(0, toMinor(b.grandTotal.toString()) - toMinor(pos.net) - t.pendingClaims);
    const instructions = await this.settings.get<string>('payments.instructions', '');
    return {
      currency: b.currency,
      grandTotal: fromMinor(toMinor(b.grandTotal.toString())),
      depositAmount: fromMinor(toMinor(b.depositAmount.toString())),
      amountPaid: fromMinor(t.received),
      amountRefunded: fromMinor(t.refunded),
      net: pos.net,
      balanceDue: pos.balanceDue,
      payable: fromMinor(payable),
      paymentStatus: pos.paymentStatus,
      instructions: instructions.trim() ? instructions : null,
    };
  }
}
