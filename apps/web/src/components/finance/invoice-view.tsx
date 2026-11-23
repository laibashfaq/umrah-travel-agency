'use client';

import { Printer } from 'lucide-react';
import type { InvoiceDto } from '@umrah/shared';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { formatDate, formatMoney } from '@/lib/format';

export function PrintButton() {
  return (
    <Button type="button" variant="outline" onClick={() => window.print()} className="print:hidden"><Printer /> Print or save as PDF</Button>
  );
}

/** One invoice, laid out to print cleanly. Used by customers and staff. */
export function InvoiceView({ invoice: i, company }: { invoice: InvoiceDto; company: { name: string; address?: string | null; phone?: string | null; email?: string | null } }) {
  const cur = i.currency;
  return (
    <article className="mx-auto max-w-3xl rounded-xl border bg-card p-6 shadow-card print:border-0 print:p-0 print:shadow-none sm:p-10" aria-label={`Invoice ${i.number}`}>
      <header className="flex flex-wrap items-start justify-between gap-6 border-b pb-6">
        <div>
          <p className="font-display text-2xl font-semibold text-primary">{company.name}</p>
          {company.address && <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{company.address}</p>}
          <p className="text-sm text-muted-foreground">{[company.phone, company.email].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="text-end">
          <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Invoice</p>
          <p className="font-display text-xl font-semibold">{i.number}</p>
          <div className="mt-2 flex justify-end"><StatusBadge domain="invoice" value={i.status} /></div>
        </div>
      </header>

      <section className="grid gap-6 py-6 sm:grid-cols-2" aria-label="Details">
        <div>
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Billed to</p>
          <p className="font-medium">{i.customer.name}</p>
          <p className="text-sm text-muted-foreground">{[i.customer.email, i.customer.phone].filter(Boolean).join(' · ')}</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:justify-self-end">
          <dt className="text-muted-foreground">Booking</dt><dd className="text-end font-medium">{i.bookingReference}</dd>
          <dt className="text-muted-foreground">Issued</dt><dd className="text-end">{i.issueDate ? formatDate(i.issueDate) : '—'}</dd>
          <dt className="text-muted-foreground">Balance due by</dt><dd className="text-end">{i.dueDate ? formatDate(i.dueDate) : '—'}</dd>
        </dl>
      </section>

      <table className="w-full text-sm">
        <caption className="sr-only">Invoice lines</caption>
        <thead>
          <tr className="border-b text-start text-xs tracking-wide text-muted-foreground uppercase">
            <th scope="col" className="py-2 text-start font-semibold">Description</th>
            <th scope="col" className="py-2 text-end font-semibold">Qty</th>
            <th scope="col" className="py-2 text-end font-semibold">Unit price</th>
            <th scope="col" className="py-2 text-end font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {i.lines.map((l, n) => (
            <tr key={n} className="border-b align-top">
              <td className="py-3 pe-4">{l.description}</td>
              <td className="py-3 text-end tabular-nums">{l.quantity}</td>
              <td className="py-3 text-end tabular-nums">{formatMoney(l.unitPrice, cur)}</td>
              <td className="py-3 text-end tabular-nums">{formatMoney(l.total, cur)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-6 ms-auto grid max-w-xs gap-2 text-sm">
        <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd className="tabular-nums">{formatMoney(i.subtotal, cur)}</dd></div>
        {Number(i.discountTotal) > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Discount</dt><dd className="tabular-nums">−{formatMoney(i.discountTotal, cur)}</dd></div>}
        {Number(i.taxTotal) > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Tax</dt><dd className="tabular-nums">{formatMoney(i.taxTotal, cur)}</dd></div>}
        <div className="flex justify-between border-t pt-2 font-semibold"><dt>Total</dt><dd className="tabular-nums">{formatMoney(i.total, cur)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">Paid</dt><dd className="tabular-nums">{formatMoney(i.amountPaid, cur)}</dd></div>
        <div className="flex justify-between font-semibold text-primary"><dt>Balance due</dt><dd className="tabular-nums">{formatMoney(i.balanceDue, cur)}</dd></div>
      </dl>

      {i.status === 'VOID' && <p className="mt-6 rounded-lg bg-muted p-3 text-sm">This invoice was cancelled{i.voidReason ? `: ${i.voidReason}` : ''}.</p>}
      {i.notes && <p className="mt-6 text-sm text-muted-foreground">{i.notes}</p>}
    </article>
  );
}
