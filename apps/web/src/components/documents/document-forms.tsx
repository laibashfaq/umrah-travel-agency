'use client';

import { useActionState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { DOCUMENT_LABEL, DOCUMENT_TYPES } from '@umrah/shared';
import { deleteDocumentAction, uploadDocumentAction } from '@/app/(customer)/account/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { FormField } from '@/components/forms/form-field';
import { NativeSelect } from '@/components/forms/native-select';
import { Input } from '@/components/ui/input';
import type { PortalFormState } from '@/lib/portal/forms';

const initial: PortalFormState = {};
const CUSTOMER_TYPES = DOCUMENT_TYPES.filter((t) => t !== 'PAYMENT_PROOF');

export function UploadDocumentForm({ travelers }: { travelers: { id: string; name: string }[] }) {
  const [state, action] = useActionState(uploadDocumentAction, initial);
  const f = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Traveler" required error={f.travelerId}>
          <NativeSelect name="travelerId" defaultValue={state.values?.travelerId ?? travelers[0]?.id ?? ''}>
            {travelers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </NativeSelect>
        </FormField>
        <FormField label="Document" required error={f.type}>
          <NativeSelect name="type" defaultValue={state.values?.type ?? 'PASSPORT'}>
            {CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{DOCUMENT_LABEL[t]}</option>)}
          </NativeSelect>
        </FormField>
        <FormField label="File" required error={f.file} hint="PDF, JPEG or PNG, up to 5 MB">
          <Input name="file" type="file" accept="application/pdf,image/jpeg,image/png" className="h-auto py-1.5" />
        </FormField>
      </div>
      <SubmitButton pending="Uploading…" className="w-fit"><Upload /> Upload document</SubmitButton>
      <p className="text-xs text-muted-foreground">Files are stored privately. Only you and the staff handling your booking can open them, and every download is logged.</p>
    </form>
  );
}

export function DeleteDocumentButton({ id, label }: { id: string; label: string }) {
  const [state, action] = useActionState(deleteDocumentAction, initial);
  return (
    <form action={action} className="grid gap-1">
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="outline" pending="Removing…" className="h-8 w-fit px-3 text-xs text-destructive"><Trash2 /> Remove<span className="sr-only"> {label}</span></SubmitButton>
      {state.error && <p role="alert" className="max-w-48 text-xs text-destructive">{state.error}</p>}
    </form>
  );
}
