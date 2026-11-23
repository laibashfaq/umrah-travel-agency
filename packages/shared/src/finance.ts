import { z } from 'zod';
import { fromMinor, toMinor } from './portal';

/* ------------------------------------------------------------------ */
/* Money position of a booking (pure: shared by API, tests and UI)      */
/* ------------------------------------------------------------------ */

export type BookingPaymentStatusKey =
  | 'UNPAID'
  | 'DEPOSIT_PAID'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'OVERDUE'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

export interface MoneyPositionInput {
  /** Booking total, deposit due now and the cancelled flag. Amounts are strings like "300000.00". */
  grandTotal: string;
  depositAmount: string;
  cancelled: boolean;
  /** Sum of successful payments and of completed refunds. */
  received: string;
  refunded: string;
}

export interface MoneyPosition {
  paymentStatus: BookingPaymentStatusKey;
  /** What the customer still owes (0 once cancelled). */
  balanceDue: string;
  /** Money held for the customer after what has been paid minus what has been refunded. */
  net: string;
}

/**
 * Derives the booking's payment status from facts, never from a stored guess.
 * A cancelled booking owes nothing; money still held is "refund pending" until it has all been returned.
 */
export function moneyPosition(i: MoneyPositionInput): MoneyPosition {
  const total = toMinor(i.grandTotal);
  const deposit = toMinor(i.depositAmount);
  const received = toMinor(i.received);
  const refunded = toMinor(i.refunded);
  const net = Math.max(0, received - refunded);

  if (i.cancelled) {
    let paymentStatus: BookingPaymentStatusKey = 'UNPAID';
    if (received > 0) paymentStatus = net > 0 ? (refunded > 0 ? 'PARTIALLY_REFUNDED' : 'REFUND_PENDING') : 'REFUNDED';
    return { paymentStatus, balanceDue: '0.00', net: fromMinor(net) };
  }

  let paymentStatus: BookingPaymentStatusKey = 'UNPAID';
  if (net >= total && total > 0) paymentStatus = 'PAID';
  else if (net > 0 && net >= deposit) paymentStatus = 'DEPOSIT_PAID';
  else if (net > 0) paymentStatus = 'PARTIALLY_PAID';
  return { paymentStatus, balanceDue: fromMinor(Math.max(0, total - net)), net: fromMinor(net) };
}

/** Largest amount that can still be paid or claimed against a booking. */
export const outstanding = (grandTotal: string, net: string): string => fromMinor(Math.max(0, toMinor(grandTotal) - toMinor(net)));

export type PaymentPurposeKey = 'DEPOSIT' | 'INSTALLMENT' | 'BALANCE' | 'FULL';

/** What a payment is for, from what it covers. */
export function purposeFor(amount: string, i: { grandTotal: string; depositAmount: string; net: string }): PaymentPurposeKey {
  const a = toMinor(amount);
  const total = toMinor(i.grandTotal);
  const net = toMinor(i.net);
  if (net + a >= total) return net === 0 ? 'FULL' : 'BALANCE';
  if (net === 0) return a >= toMinor(i.depositAmount) ? 'DEPOSIT' : 'INSTALLMENT';
  return net < toMinor(i.depositAmount) ? 'DEPOSIT' : 'INSTALLMENT';
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const text = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());
const amount = z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Enter an amount like 75000 or 75000.50').refine((v) => toMinor(v) > 0, 'Amount must be more than zero');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Enter a real date');
const pastDate = isoDate.refine((v) => v <= new Date().toISOString().slice(0, 10), 'The payment date cannot be in the future');

export const CUSTOMER_PAYMENT_METHODS = ['BANK_TRANSFER', 'MOBILE_WALLET', 'CASH', 'CHEQUE'] as const;
export const STAFF_PAYMENT_METHODS = ['BANK_TRANSFER', 'MOBILE_WALLET', 'CASH', 'CHEQUE', 'CARD'] as const;

/** A customer telling us they have paid, for finance to check against the bank. */
export const reportPaymentSchema = z.object({
  bookingId: z.string().uuid(),
  method: z.enum(CUSTOMER_PAYMENT_METHODS),
  amount,
  paidOn: pastDate,
  transactionRef: text(80),
  note: text(300),
});
export type ReportPaymentInput = z.infer<typeof reportPaymentSchema>;

export const recordPaymentSchema = z.object({
  bookingId: z.string().uuid(),
  method: z.enum(STAFF_PAYMENT_METHODS),
  amount,
  paidOn: pastDate,
  transactionRef: text(80),
  note: text(300),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const verifyPaymentSchema = z
  .object({ decision: z.enum(['APPROVE', 'REJECT']), note: text(300) })
  .refine((v) => v.decision === 'APPROVE' || Boolean(v.note), { message: 'Say why the payment is rejected', path: ['note'] });
export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;

export const adminPaymentQuery = z.object({
  q: z.preprocess(blank, z.string().trim().max(100).optional()),
  status: z.preprocess(blank, z.enum(['PENDING', 'AWAITING_VERIFICATION', 'SUCCESSFUL', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED']).optional()),
  bookingId: z.preprocess(blank, z.string().uuid().optional()),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const requestRefundSchema = z.object({
  paymentId: z.string().uuid(),
  amount,
  reason: z.string().trim().min(3, 'Give a reason').max(300),
});
export type RequestRefundInput = z.infer<typeof requestRefundSchema>;

export const refundActionSchema = z
  .object({ action: z.enum(['approve', 'reject', 'complete', 'fail']), note: text(300) })
  .refine((v) => (v.action !== 'reject' && v.action !== 'fail') || Boolean(v.note), { message: 'Say why', path: ['note'] });
export type RefundActionInput = z.infer<typeof refundActionSchema>;

export const adminRefundQuery = z.object({
  status: z.preprocess(blank, z.enum(['REQUESTED', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED']).optional()),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const adminInvoiceQuery = z.object({
  q: z.preprocess(blank, z.string().trim().max(100).optional()),
  status: z.preprocess(blank, z.enum(['ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID', 'REFUNDED']).optional()),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const voidInvoiceSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */

export interface PaymentDto {
  id: string;
  reference: string;
  bookingId: string;
  bookingReference: string;
  customerName: string;
  method: string;
  purpose: string;
  status: string;
  amount: string;
  currency: string;
  paidOn: string | null;
  transactionRef: string | null;
  note: string | null;
  failureMessage: string | null;
  recordedByName: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  refundedAmount: string;
  createdAt: string;
}

export interface RefundDto {
  id: string;
  paymentId: string;
  paymentReference: string;
  bookingId: string;
  bookingReference: string;
  customerName: string;
  amount: string;
  currency: string;
  reason: string;
  status: string;
  requestedByName: string | null;
  approvedByName: string | null;
  processedAt: string | null;
  failureMessage: string | null;
  createdAt: string;
}

export interface InvoiceLineDto {
  description: string;
  quantity: number;
  unitPrice: string;
  total: string;
}

export interface InvoiceDto {
  id: string;
  number: string;
  status: string;
  bookingId: string;
  bookingReference: string;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  notes: string | null;
  voidReason: string | null;
  customer: { name: string; email: string | null; phone: string | null };
  lines: InvoiceLineDto[];
}

export interface BookingMoneyDto {
  currency: string;
  grandTotal: string;
  depositAmount: string;
  amountPaid: string;
  amountRefunded: string;
  net: string;
  balanceDue: string;
  /** Largest payment that can still be reported or recorded. */
  payable: string;
  paymentStatus: string;
  instructions: string | null;
}
