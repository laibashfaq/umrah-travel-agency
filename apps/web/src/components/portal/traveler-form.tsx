'use client';

import { useActionState } from 'react';
import { Trash2 } from 'lucide-react';
import { deleteTravelerAction, saveTravelerAction } from '@/app/(customer)/account/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { FormField } from '@/components/forms/form-field';
import { NativeSelect } from '@/components/forms/native-select';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { COUNTRIES } from '@/lib/countries';
import type { PortalFormState } from '@/lib/portal/forms';
import type { TravelerDto } from '@umrah/shared';

const initial: PortalFormState = {};

const RELATIONSHIPS: [string, string][] = [
  ['SELF', 'Myself'], ['SPOUSE', 'Spouse'], ['CHILD', 'Child'], ['PARENT', 'Parent'], ['SIBLING', 'Brother or sister'], ['RELATIVE', 'Other relative'], ['OTHER', 'Friend or other'],
];

interface Props {
  traveler?: TravelerDto;
  /** Other saved travelers, offered as a mahram. */
  others: TravelerDto[];
  returnTo?: string;
}

export function TravelerForm({ traveler, others, returnTo }: Props) {
  const [state, action] = useActionState(saveTravelerAction, initial);
  const f = state.fieldErrors ?? {};
  const v = (key: keyof TravelerDto): string => state.values?.[key] ?? (traveler?.[key] as string | null | undefined) ?? '';
  const countryOptions = COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>);
  return (
    <form action={action} className="grid max-w-3xl gap-8" noValidate>
      {traveler && <input type="hidden" name="id" value={traveler.id} />}
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <FormMessage state={state} />

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-display text-lg font-semibold">Personal details</legend>
        <p className="text-sm text-muted-foreground sm:col-span-2">Enter names exactly as they appear on the passport.</p>
        <FormField label="Who is this?" error={f.relationship}>
          <NativeSelect name="relationship" defaultValue={v('relationship') || 'SELF'}>{RELATIONSHIPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</NativeSelect>
        </FormField>
        <FormField label="Title" error={f.title}>
          <NativeSelect name="title" defaultValue={v('title')}>
            <option value="">—</option>
            {['Mr', 'Mrs', 'Ms', 'Miss', 'Master', 'Dr'].map((t) => <option key={t}>{t}</option>)}
          </NativeSelect>
        </FormField>
        <FormField label="First name" required error={f.firstName}><Input name="firstName" autoComplete="off" defaultValue={v('firstName')} /></FormField>
        <FormField label="Middle name" error={f.middleName}><Input name="middleName" autoComplete="off" defaultValue={v('middleName')} /></FormField>
        <FormField label="Last name" required error={f.lastName}><Input name="lastName" autoComplete="off" defaultValue={v('lastName')} /></FormField>
        <FormField label="Father’s or husband’s name" error={f.fatherOrHusbandName}><Input name="fatherOrHusbandName" autoComplete="off" defaultValue={v('fatherOrHusbandName')} /></FormField>
        <FormField label="Gender" required error={f.gender}>
          <NativeSelect name="gender" defaultValue={v('gender')}>
            <option value="" disabled>Select…</option>
            <option value="MALE">Male</option>
            <option value="FEMALE">Female</option>
          </NativeSelect>
        </FormField>
        <FormField label="Date of birth" required error={f.dateOfBirth}><Input name="dateOfBirth" type="date" defaultValue={v('dateOfBirth')} /></FormField>
        <FormField label="Place of birth" error={f.placeOfBirth}><Input name="placeOfBirth" autoComplete="off" defaultValue={v('placeOfBirth')} /></FormField>
        <FormField label="Nationality" required error={f.nationality}>
          <NativeSelect name="nationality" defaultValue={v('nationality') || 'PK'}>{countryOptions}</NativeSelect>
        </FormField>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-display text-lg font-semibold">Passport and ID</legend>
        <p className="text-sm text-muted-foreground sm:col-span-2">Stored encrypted and only shown masked. The passport must be valid for 6 months after you return.</p>
        <FormField label="Passport number" error={f.passportNumber} hint={traveler?.passportNumberMasked ? `Saved: ${traveler.passportNumberMasked}. Leave blank to keep it.` : undefined}>
          <Input name="passportNumber" autoComplete="off" spellCheck={false} className="uppercase" />
        </FormField>
        <FormField label="Issuing country" error={f.passportIssuingCountry}>
          <NativeSelect name="passportIssuingCountry" defaultValue={v('passportIssuingCountry') || 'PK'}>{countryOptions}</NativeSelect>
        </FormField>
        <FormField label="Issue date" error={f.passportIssueDate}><Input name="passportIssueDate" type="date" defaultValue={v('passportIssueDate')} /></FormField>
        <FormField label="Expiry date" error={f.passportExpiryDate}><Input name="passportExpiryDate" type="date" defaultValue={v('passportExpiryDate')} /></FormField>
        <FormField label="CNIC / national ID" error={f.nationalId} hint={traveler?.nationalIdMasked ? `Saved: ${traveler.nationalIdMasked}. Leave blank to keep it.` : undefined}>
          <Input name="nationalId" autoComplete="off" spellCheck={false} placeholder="42101-1234567-1" />
        </FormField>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-display text-lg font-semibold">Contact and care</legend>
        <FormField label="Phone" error={f.phone}><Input name="phone" type="tel" inputMode="tel" defaultValue={v('phone')} /></FormField>
        <FormField label="Email" error={f.email}><Input name="email" type="email" inputMode="email" defaultValue={v('email')} /></FormField>
        <FormField label="Mahram (if travelling with one)" error={f.mahramTravelerId}>
          <NativeSelect name="mahramTravelerId" defaultValue={v('mahramTravelerId')}>
            <option value="">None</option>
            {others.map((o) => <option key={o.id} value={o.id}>{o.firstName} {o.lastName}</option>)}
          </NativeSelect>
        </FormField>
        <FormField label="Relationship to mahram" error={f.mahramRelationship}><Input name="mahramRelationship" placeholder="e.g. husband, father" defaultValue={v('mahramRelationship')} /></FormField>
        <FormField label="Special requirements" className="sm:col-span-2" error={f.specialRequirements} hint="Wheelchair, medical needs, dietary needs…">
          <Textarea name="specialRequirements" rows={3} defaultValue={v('specialRequirements')} />
        </FormField>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending="Saving…" className="w-auto">{traveler ? 'Save changes' : 'Add traveler'}</SubmitButton>
        <Button asChild variant="ghost"><a href={returnTo ?? '/account/travelers'}>Cancel</a></Button>
      </div>
    </form>
  );
}

export function DeleteTravelerButton({ traveler }: { traveler: TravelerDto }) {
  const [state, action] = useActionState(deleteTravelerAction, initial);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="text-destructive"><Trash2 /> Remove</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {traveler.firstName} {traveler.lastName}?</DialogTitle>
          <DialogDescription>This deletes the saved details. Travelers on an active booking cannot be removed.</DialogDescription>
        </DialogHeader>
        <form action={action} className="grid gap-4">
          <input type="hidden" name="id" value={traveler.id} />
          <FormMessage state={state} />
          <DialogFooter>
            <SubmitButton variant="destructive" pending="Removing…" className="w-auto">Remove traveler</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
