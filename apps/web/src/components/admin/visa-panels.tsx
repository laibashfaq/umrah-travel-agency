'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { Check, Stamp, X } from 'lucide-react';
import type { VisaStatusKey } from '@umrah/shared';
import { assignVisaAction, changeVisaStatusAction, reviewDocumentAction, startVisasAction } from '@/app/(admin)/admin/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { FormField } from '@/components/forms/form-field';
import { NativeSelect } from '@/components/forms/native-select';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { PortalFormState } from '@/lib/portal/forms';
import { getStatusMeta } from '@/lib/status';

const initial: PortalFormState = {};

export function ReviewDocumentButtons({ documentId, label, returnTo }: { documentId: string; label: string; returnTo: string }) {
  const [state, action] = useActionState(reviewDocumentAction, initial);
  return (
    <div className="grid gap-2">
      {state.error && <p role="alert" className="max-w-56 text-xs text-destructive">{state.error}</p>}
      <div className="flex flex-wrap gap-2">
        <form action={action}>
          <input type="hidden" name="documentId" value={documentId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="decision" value="APPROVE" />
          <SubmitButton pending="Saving…" className="h-8 w-fit px-3 text-xs"><Check /> Approve<span className="sr-only"> {label}</span></SubmitButton>
        </form>
        <Dialog>
          <DialogTrigger asChild><Button variant="outline" size="sm" className="text-destructive"><X /> Reject<span className="sr-only"> {label}</span></Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Ask for a new upload?</DialogTitle><DialogDescription>The customer sees this reason next to the document.</DialogDescription></DialogHeader>
            <form action={action} className="grid gap-4">
              <input type="hidden" name="documentId" value={documentId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="decision" value="REJECT" />
              <FormField label="What needs fixing" required error={state.fieldErrors?.reason}><Textarea name="reason" rows={3} maxLength={300} placeholder="e.g. The photo page is cut off" /></FormField>
              <DialogFooter><SubmitButton variant="destructive" pending="Saving…" className="w-fit">Reject document</SubmitButton></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

export function StartVisasButton({ bookingId }: { bookingId: string }) {
  const [state, action] = useActionState(startVisasAction, initial);
  return (
    <form action={action} className="grid gap-1">
      <input type="hidden" name="bookingId" value={bookingId} />
      {state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
      <SubmitButton variant="outline" pending="Starting…" className="w-fit"><Stamp /> Start visa applications</SubmitButton>
    </form>
  );
}

export function VisaStatusPanel({ visaId, allowed, canUpdate }: { visaId: string; allowed: VisaStatusKey[]; canUpdate: boolean }) {
  const [state, action] = useActionState(changeVisaStatusAction, initial);
  const [to, setTo] = React.useState<string>(allowed[0] ?? '');
  if (allowed.length === 0) return <p className="text-sm text-muted-foreground">This application is finished.</p>;
  if (!canUpdate) return <p className="text-sm text-muted-foreground">Your role cannot change visa applications.</p>;
  const f = state.fieldErrors ?? {};
  const v = (k: string) => state.values?.[k] ?? '';
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="visaId" value={visaId} />
      {/* The chosen status is submitted from state, so React's form reset after an error cannot change it. */}
      <input type="hidden" name="toStatus" value={to} />
      <FormMessage state={state} />
      <FormField label="Move to" error={f.toStatus}>
        <NativeSelect key={`${to}-${state.error ?? ''}`} value={to} onChange={(e) => setTo(e.target.value)}>
          {allowed.map((s) => <option key={s} value={s}>{getStatusMeta('visa', s).label}</option>)}
        </NativeSelect>
      </FormField>
      {to === 'SUBMITTED' && (
        <>
          <FormField label="Application number" error={f.applicationNumber}><Input name="applicationNumber" defaultValue={v('applicationNumber')} /></FormField>
          <FormField label="Portal reference (Nusuk / MOFA)" error={f.externalReference}><Input name="externalReference" defaultValue={v('externalReference')} /></FormField>
        </>
      )}
      {to === 'ISSUED' && (
        <>
          <FormField label="Visa number" required error={f.visaNumber}><Input name="visaNumber" defaultValue={v('visaNumber')} /></FormField>
          <FormField label="Valid from" required error={f.validFrom}><Input name="validFrom" type="date" defaultValue={v('validFrom')} /></FormField>
          <FormField label="Valid until" required error={f.validUntil}><Input name="validUntil" type="date" defaultValue={v('validUntil')} /></FormField>
        </>
      )}
      {to === 'REJECTED' && <FormField label="Reason (shown to the customer)" required error={f.rejectionReason}><Textarea name="rejectionReason" rows={3} maxLength={300} defaultValue={v('rejectionReason')} /></FormField>}
      <FormField label="Internal note (optional)" error={f.note}><Textarea name="note" rows={2} maxLength={500} defaultValue={v('note')} /></FormField>
      <SubmitButton pending="Saving…" className="w-fit">Update application</SubmitButton>
    </form>
  );
}

export function VisaAssignPanel({ visaId, assignedOfficerId, officers, canAssign }: { visaId: string; assignedOfficerId: string | null; officers: { id: string; name: string }[]; canAssign: boolean }) {
  const [state, action] = useActionState(assignVisaAction, initial);
  return (
    <form action={action} className="grid gap-3" noValidate>
      <input type="hidden" name="visaId" value={visaId} />
      <FormMessage state={state} />
      <FormField label="Visa officer">
        <NativeSelect name="assignedOfficerId" defaultValue={assignedOfficerId ?? ''} disabled={!canAssign}>
          <option value="">Unassigned</option>
          {officers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </NativeSelect>
      </FormField>
      {canAssign && <SubmitButton variant="outline" pending="Saving…" className="w-fit">Save officer</SubmitButton>}
    </form>
  );
}
