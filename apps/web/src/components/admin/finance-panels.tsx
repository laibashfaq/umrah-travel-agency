'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { Check, FilePlus2, RotateCcw, X } from 'lucide-react';
import { issueInvoiceAction, recordPaymentAction, refundAction, requestRefundAction, verifyPaymentAction, voidInvoiceAction } from '@/app/(admin)/admin/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { FormField } from '@/components/forms/form-field';
import { NativeSelect } from '@/components/forms/native-select';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { PortalFormState } from '@/lib/portal/forms';

const initial: PortalFormState = {};
const today = () => new Date().toISOString().slice(0, 10);

export function RecordPaymentForm({ bookingId, payable, countsAtOnce }: { bookingId: string; payable: string; countsAtOnce: boolean }) {
  const [state, action] = useActionState(recordPaymentAction, initial);
  const f = state.fieldErrors ?? {};
  const v = (k: string, d = '') => state.values?.[k] ?? d;
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="bookingId" value={bookingId} />
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Method" error={f.method}>
          <NativeSelect name="method" defaultValue={v('method', 'BANK_TRANSFER')}>
            <option value="BANK_TRANSFER">Bank transfer</option><option value="CASH">Cash</option><option value="CHEQUE">Cheque</option><option value="MOBILE_WALLET">Mobile wallet</option><option value="CARD">Card (office terminal)</option>
          </NativeSelect>
        </FormField>
        <FormField label="Amount (PKR)" required error={f.amount} hint={`Up to ${payable}`}><Input name="amount" inputMode="decimal" defaultValue={v('amount')} /></FormField>
        <FormField label="Date received" required error={f.paidOn}><Input name="paidOn" type="date" max={today()} defaultValue={v('paidOn', today())} /></FormField>
        <FormField label="Transaction or receipt number" error={f.transactionRef}><Input name="transactionRef" defaultValue={v('transactionRef')} /></FormField>
      </div>
      <FormField label="Note" error={f.note}><Input name="note" maxLength={300} defaultValue={v('note')} /></FormField>
      <SubmitButton pending="Saving…" className="w-fit">Record payment</SubmitButton>
      <p className="text-xs text-muted-foreground">{countsAtOnce ? 'As you can verify payments, this counts immediately and may confirm the booking.' : 'It will wait for a finance officer to verify it before it counts.'}</p>
    </form>
  );
}

export function VerifyButtons({ paymentId, amount, returnTo }: { paymentId: string; amount: string; returnTo: string }) {
  const [state, action] = useActionState(verifyPaymentAction, initial);
  return (
    <div className="grid gap-2">
      {state.error && <p role="alert" className="max-w-56 text-xs text-destructive">{state.error}</p>}
      {state.ok && <p role="status" className="text-xs text-success">{state.message}</p>}
      <div className="flex flex-wrap gap-2">
        <form action={action}>
          <input type="hidden" name="paymentId" value={paymentId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="decision" value="APPROVE" />
          <SubmitButton pending="Saving…" className="w-fit"><Check /> Verify<span className="sr-only"> payment of {amount}</span></SubmitButton>
        </form>
        <Dialog>
          <DialogTrigger asChild><Button variant="outline" className="text-destructive"><X /> Reject<span className="sr-only"> payment of {amount}</span></Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Reject this payment?</DialogTitle><DialogDescription>The customer is told why. They can report it again if it was a mistake.</DialogDescription></DialogHeader>
            <form action={action} className="grid gap-4">
              <input type="hidden" name="paymentId" value={paymentId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="decision" value="REJECT" />
              <FormField label="Reason" required error={state.fieldErrors?.note}><Textarea name="note" rows={3} maxLength={300} /></FormField>
              <DialogFooter><SubmitButton variant="destructive" pending="Saving…" className="w-fit">Reject payment</SubmitButton></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

export function RefundRequestDialog({ paymentId, reference, max }: { paymentId: string; reference: string; max: string }) {
  const [state, action] = useActionState(requestRefundAction, initial);
  const f = state.fieldErrors ?? {};
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" size="sm"><RotateCcw /> Refund<span className="sr-only"> payment {reference}</span></Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Request a refund</DialogTitle><DialogDescription>From payment {reference}. Someone else must approve it, and it only changes the booking once it has been paid out.</DialogDescription></DialogHeader>
        <form action={action} className="grid gap-4" noValidate>
          <input type="hidden" name="paymentId" value={paymentId} />
          <FormMessage state={state} />
          <FormField label="Amount (PKR)" required error={f.amount} hint={`Up to ${max}`}><Input name="amount" inputMode="decimal" defaultValue={state.values?.amount} /></FormField>
          <FormField label="Reason" required error={f.reason}><Textarea name="reason" rows={3} maxLength={300} defaultValue={state.values?.reason} /></FormField>
          <DialogFooter><SubmitButton pending="Saving…" className="w-fit">Request refund</SubmitButton></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RefundActions({ refundId, status, canApprove, returnTo }: { refundId: string; status: string; canApprove: boolean; returnTo: string }) {
  const [state, action] = useActionState(refundAction, initial);
  const [note, setNote] = React.useState('');
  if (!canApprove || (status !== 'REQUESTED' && status !== 'APPROVED')) return null;
  const buttons = status === 'REQUESTED' ? [['approve', 'Approve', 'default'], ['reject', 'Reject', 'outline']] as const : [['complete', 'Mark as paid', 'default'], ['fail', 'Mark as failed', 'outline']] as const;
  return (
    <form action={action} className="grid gap-2" noValidate>
      <input type="hidden" name="refundId" value={refundId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      {state.error && <p role="alert" className="max-w-64 text-xs text-destructive">{state.error}</p>}
      {state.ok && <p role="status" className="text-xs text-success">{state.message}</p>}
      <Input name="note" aria-label="Note or bank reference" placeholder={status === 'REQUESTED' ? 'Reason (needed to reject)' : 'Bank reference (needed if failed: the reason)'} value={note} onChange={(e) => setNote(e.target.value)} className="max-w-64" />
      <div className="flex flex-wrap gap-2">
        {buttons.map(([act, label, variant]) => (
          <Button key={act} type="submit" name="action" value={act} variant={variant}>{label}</Button>
        ))}
      </div>
    </form>
  );
}

export function IssueInvoiceButton({ bookingId }: { bookingId: string }) {
  const [state, action] = useActionState(issueInvoiceAction, initial);
  return (
    <form action={action} className="grid gap-1">
      <input type="hidden" name="bookingId" value={bookingId} />
      {state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
      <SubmitButton variant="outline" pending="Issuing…" className="w-fit"><FilePlus2 /> Issue invoice</SubmitButton>
    </form>
  );
}

export function VoidInvoiceDialog({ invoiceId, number }: { invoiceId: string; number: string }) {
  const [state, action] = useActionState(voidInvoiceAction, initial);
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" className="text-destructive">Void invoice</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Void invoice {number}?</DialogTitle><DialogDescription>It stays on record as void. Invoices with payments against them cannot be voided.</DialogDescription></DialogHeader>
        <form action={action} className="grid gap-4" noValidate>
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <FormMessage state={state} />
          <FormField label="Reason" required error={state.fieldErrors?.reason}><Textarea name="reason" rows={3} maxLength={300} defaultValue={state.values?.reason} /></FormField>
          <DialogFooter><SubmitButton variant="destructive" pending="Voiding…" className="w-fit">Void invoice</SubmitButton></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
