'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { addNoteAction, assignBookingAction, changeBookingStatusAction } from '@/app/(admin)/admin/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { FormField } from '@/components/forms/form-field';
import { NativeSelect } from '@/components/forms/native-select';
import { Textarea } from '@/components/ui/textarea';
import { getStatusMeta } from '@/lib/status';
import type { PortalFormState } from '@/lib/portal/forms';
import type { BookingStatusKey } from '@umrah/shared';

const initial: PortalFormState = {};

export function StatusPanel({ bookingId, allowed, canUpdate, canCancel }: { bookingId: string; allowed: BookingStatusKey[]; canUpdate: boolean; canCancel: boolean }) {
  const [state, action] = useActionState(changeBookingStatusAction, initial);
  const options = allowed.filter((s) => (s === 'CANCELLED' ? canCancel : canUpdate));
  const [to, setTo] = React.useState<string>(options[0] ?? '');
  if (options.length === 0) {
    return <p className="text-sm text-muted-foreground">{allowed.length === 0 ? 'This booking is finished: no further changes are possible.' : 'Your role cannot change this booking’s status.'}</p>;
  }
  const f = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="bookingId" value={bookingId} />
      <FormMessage state={state} />
      {/* React resets form controls after every action. The status that is submitted lives in a hidden field driven by state, so a failed attempt can never turn into a different status on retry. */}
      <input type="hidden" name="toStatus" value={to} />
      <FormField label="Move to" error={f.toStatus}>
        <NativeSelect key={`${to}-${state.error ?? ''}`} value={to} onChange={(e) => setTo(e.target.value)}>
          {options.map((s) => <option key={s} value={s}>{getStatusMeta('booking', s).label}</option>)}
        </NativeSelect>
      </FormField>
      <FormField label={to === 'CANCELLED' ? 'Reason (required)' : 'Note (optional)'} error={f.note} hint={to === 'CONFIRMED' ? 'Confirming does not record a payment. Say how the deposit was received.' : to === 'CANCELLED' ? 'Seats are released straight away.' : undefined}>
        <Textarea name="note" rows={3} maxLength={500} defaultValue={state.values?.note} />
      </FormField>
      <SubmitButton variant={to === 'CANCELLED' ? 'destructive' : 'default'} pending="Saving…" className="w-fit">{to === 'CANCELLED' ? 'Cancel booking' : 'Update status'}</SubmitButton>
    </form>
  );
}

export function AssignPanel({ bookingId, assignedToId, staff, canAssign }: { bookingId: string; assignedToId: string | null; staff: { id: string; name: string }[]; canAssign: boolean }) {
  const [state, action] = useActionState(assignBookingAction, initial);
  return (
    <form action={action} className="grid gap-3" noValidate>
      <input type="hidden" name="bookingId" value={bookingId} />
      <FormMessage state={state} />
      <FormField label="Handled by">
        <NativeSelect name="assignedToId" defaultValue={assignedToId ?? ''} disabled={!canAssign}>
          <option value="">Unassigned</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </NativeSelect>
      </FormField>
      {canAssign && <SubmitButton variant="outline" pending="Saving…" className="w-fit">Save assignment</SubmitButton>}
    </form>
  );
}

export function NoteForm({ target, id }: { target: 'booking' | 'customer'; id: string }) {
  const [state, action] = useActionState(addNoteAction, initial);
  const ref = React.useRef<HTMLFormElement>(null);
  React.useEffect(() => {
    if (state.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="grid gap-3" noValidate>
      <input type="hidden" name="target" value={target} />
      <input type="hidden" name="id" value={id} />
      <FormMessage state={state} />
      <FormField label="Add an internal note" error={state.fieldErrors?.body} hint="Only staff can see notes.">
        <Textarea name="body" rows={3} maxLength={2000} />
      </FormField>
      <SubmitButton variant="outline" pending="Saving…" className="w-fit">Add note</SubmitButton>
    </form>
  );
}
