'use client';

import { useActionState } from 'react';
import { reportPaymentAction } from '@/app/(customer)/account/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { FormField } from '@/components/forms/form-field';
import { NativeSelect } from '@/components/forms/native-select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { PortalFormState } from '@/lib/portal/forms';

const initial: PortalFormState = {};
const today = () => new Date().toISOString().slice(0, 10);

/** The customer says they have paid. It does not count until finance has checked it against the bank. */
export function ReportPaymentForm({ bookingId, payable, suggested }: { bookingId: string; payable: string; suggested: string }) {
  const [state, action] = useActionState(reportPaymentAction, initial);
  const f = state.fieldErrors ?? {};
  const v = (k: string, fallback = '') => state.values?.[k] ?? fallback;
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="bookingId" value={bookingId} />
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="How did you pay?" error={f.method}>
          <NativeSelect name="method" defaultValue={v('method', 'BANK_TRANSFER')}>
            <option value="BANK_TRANSFER">Bank transfer</option>
            <option value="MOBILE_WALLET">Mobile wallet</option>
            <option value="CASH">Cash at our office</option>
            <option value="CHEQUE">Cheque</option>
          </NativeSelect>
        </FormField>
        <FormField label="Amount paid (PKR)" required error={f.amount} hint={`Up to ${payable}`}>
          <Input name="amount" inputMode="decimal" defaultValue={v('amount', suggested)} />
        </FormField>
        <FormField label="Date paid" required error={f.paidOn}><Input name="paidOn" type="date" max={today()} defaultValue={v('paidOn', today())} /></FormField>
        <FormField label="Transaction or receipt number" error={f.transactionRef} hint="Helps us find it on the statement"><Input name="transactionRef" defaultValue={v('transactionRef')} /></FormField>
      </div>
      <FormField label="Anything else? (optional)" error={f.note}><Textarea name="note" rows={2} maxLength={300} defaultValue={v('note')} /></FormField>
      <SubmitButton pending="Sending…" className="w-fit">Tell us I have paid</SubmitButton>
      <p className="text-xs text-muted-foreground">Your payment is confirmed once our finance team has seen it in the bank. You will see its status here.</p>
    </form>
  );
}
