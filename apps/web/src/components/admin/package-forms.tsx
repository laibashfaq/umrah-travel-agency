'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { BOOKABLE_OCCUPANCIES, type AdminDepartureDto, type AdminPackageDetailDto } from '@umrah/shared';
import { deleteDepartureAction, savePackageAction, saveDepartureAction, setPackageStatusAction } from '@/app/(admin)/admin/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { FormField } from '@/components/forms/form-field';
import { NativeSelect } from '@/components/forms/native-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { PortalFormState } from '@/lib/portal/forms';

const initial: PortalFormState = {};
const OCC_LABEL: Record<string, string> = { SINGLE: 'Single', DOUBLE: 'Double', TRIPLE: 'Triple', QUAD: 'Quad', QUINT: 'Quint', SHARING: 'Sharing' };

function Check({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  const id = React.useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} name={name} defaultChecked={defaultChecked} />
      <Label htmlFor={id} className="font-normal">{label}</Label>
    </div>
  );
}

export function PackageForm({ pkg, canEdit = true }: { pkg?: AdminPackageDetailDto; canEdit?: boolean }) {
  const [state, action] = useActionState(savePackageAction, initial);
  const f = state.fieldErrors ?? {};
  const v = (key: string, fallback: string | number | null | undefined = ''): string => state.values?.[key] ?? String(fallback ?? '');
  const flag = (key: string, fallback: boolean) => (state.values ? state.values[key] === 'on' : fallback);
  const lines = (key: string, list: string[] | undefined) => state.values?.[key] ?? (list ?? []).join('\n');
  const slugLocked = pkg !== undefined && pkg.status !== 'DRAFT';
  return (
    <form action={action} className="grid max-w-3xl gap-8" noValidate>
      {pkg && <input type="hidden" name="id" value={pkg.id} />}
      <FormMessage state={state} />
      <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-display text-lg font-semibold">Basics</legend>
        <FormField label="Title" required error={f.title} className="sm:col-span-2"><Input name="title" defaultValue={v('title', pkg?.title)} /></FormField>
        <FormField label="Web address" required error={f.slug} hint={slugLocked ? 'Locked while the package is live.' : 'Lower-case letters, digits and dashes, e.g. economy-umrah-14-days'}>
          <Input name="slug" defaultValue={v('slug', pkg?.slug)} readOnly={slugLocked} spellCheck={false} />
        </FormField>
        <FormField label="Subtitle" error={f.subtitle}><Input name="subtitle" defaultValue={v('subtitle', pkg?.subtitle)} /></FormField>
        <FormField label="Short summary" className="sm:col-span-2" error={f.summary}><Textarea name="summary" rows={2} defaultValue={v('summary', pkg?.summary)} /></FormField>
        <FormField label="Description" className="sm:col-span-2" error={f.description}><Textarea name="description" rows={6} defaultValue={v('description', pkg?.description)} /></FormField>
      </fieldset>

      <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-display text-lg font-semibold">Trip</legend>
        <FormField label="Tier" error={f.tier}>
          <NativeSelect name="tier" defaultValue={v('tier', pkg?.tier ?? 'STANDARD')}>
            {['ECONOMY', 'STANDARD', 'PREMIUM', 'VIP'].map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
          </NativeSelect>
        </FormField>
        <FormField label="Meals" error={f.mealPlan}>
          <NativeSelect name="mealPlan" defaultValue={v('mealPlan', pkg?.mealPlan ?? 'ROOM_ONLY')}>
            {[['ROOM_ONLY', 'Room only'], ['BREAKFAST', 'Breakfast'], ['HALF_BOARD', 'Half board'], ['FULL_BOARD', 'Full board']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </NativeSelect>
        </FormField>
        <FormField label="Days in total" required error={f.durationDays}><Input name="durationDays" type="number" min={1} max={60} defaultValue={v('durationDays', pkg?.durationDays ?? 14)} /></FormField>
        <FormField label="Nights in Makkah" error={f.nightsMakkah}><Input name="nightsMakkah" type="number" min={0} defaultValue={v('nightsMakkah', pkg?.nightsMakkah ?? 0)} /></FormField>
        <FormField label="Nights in Madinah" error={f.nightsMadinah}><Input name="nightsMadinah" type="number" min={0} defaultValue={v('nightsMadinah', pkg?.nightsMadinah ?? 0)} /></FormField>
        <FormField label="Departure cities" error={f.departureCities} hint="One per line"><Textarea name="departureCities" rows={3} defaultValue={lines('departureCities', pkg?.departureCities)} /></FormField>
        <FormField label="Inclusions" error={f.inclusions} hint="One per line"><Textarea name="inclusions" rows={5} defaultValue={lines('inclusions', pkg?.inclusions)} /></FormField>
        <FormField label="Exclusions" error={f.exclusions} hint="One per line"><Textarea name="exclusions" rows={5} defaultValue={lines('exclusions', pkg?.exclusions)} /></FormField>
        <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
          <Check name="visaIncluded" label="Visa included" defaultChecked={flag('visaIncluded', pkg?.visaIncluded ?? true)} />
          <Check name="flightIncluded" label="Flights included" defaultChecked={flag('flightIncluded', pkg?.flightIncluded ?? false)} />
          <Check name="transportIncluded" label="Ground transport included" defaultChecked={flag('transportIncluded', pkg?.transportIncluded ?? true)} />
          <Check name="ziyaratIncluded" label="Ziyarat included" defaultChecked={flag('ziyaratIncluded', pkg?.ziyaratIncluded ?? false)} />
          <Check name="isFeatured" label="Feature on the home page" defaultChecked={flag('isFeatured', pkg?.isFeatured ?? false)} />
        </div>
      </fieldset>

      <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-display text-lg font-semibold">Deposit and terms</legend>
        <FormField label="Deposit type" error={f.depositType}>
          <NativeSelect name="depositType" defaultValue={v('depositType', pkg?.depositType ?? 'PERCENTAGE')}>
            <option value="PERCENTAGE">Percentage of total</option>
            <option value="FIXED_PER_PERSON">Fixed amount per person</option>
            <option value="FIXED_PER_BOOKING">Fixed amount per booking</option>
          </NativeSelect>
        </FormField>
        <FormField label="Deposit value" error={f.depositValue} hint="25 means 25% for a percentage; otherwise an amount in PKR"><Input name="depositValue" inputMode="decimal" defaultValue={v('depositValue', pkg?.depositValue ?? '25')} /></FormField>
        <FormField label="Terms" className="sm:col-span-2" error={f.terms}><Textarea name="terms" rows={4} defaultValue={v('terms', pkg?.terms)} /></FormField>
        <FormField label="Search title" error={f.seoTitle}><Input name="seoTitle" defaultValue={v('seoTitle', pkg?.seoTitle)} /></FormField>
        <FormField label="Search description" error={f.seoDescription}><Input name="seoDescription" defaultValue={v('seoDescription', pkg?.seoDescription)} /></FormField>
      </fieldset>

      {canEdit && <SubmitButton pending="Saving…" className="w-fit">{pkg ? 'Save package' : 'Create package'}</SubmitButton>}
    </form>
  );
}

export function PackageStatusPanel({ pkg, canPublish }: { pkg: AdminPackageDetailDto; canPublish: boolean }) {
  const [state, action] = useActionState(setPackageStatusAction, initial);
  if (!canPublish) return <p className="text-sm text-muted-foreground">Your role cannot publish or archive packages.</p>;
  const buttons: { status: string; label: string; variant: 'default' | 'outline' | 'destructive' }[] =
    pkg.status === 'PUBLISHED'
      ? [{ status: 'DRAFT', label: 'Unpublish (back to draft)', variant: 'outline' }, { status: 'ARCHIVED', label: 'Archive', variant: 'outline' }]
      : pkg.status === 'ARCHIVED'
        ? [{ status: 'DRAFT', label: 'Restore as draft', variant: 'outline' }]
        : [{ status: 'PUBLISHED', label: 'Publish', variant: 'default' }, { status: 'ARCHIVED', label: 'Archive', variant: 'outline' }];
  return (
    <div className="grid gap-3">
      <FormMessage state={state} />
      {pkg.status === 'DRAFT' && pkg.publishBlockers.length > 0 && (
        <ul className="list-disc ps-5 text-sm text-warning">{pkg.publishBlockers.map((b) => <li key={b}>{b}</li>)}</ul>
      )}
      <div className="flex flex-wrap gap-2">
        {buttons.map((b) => (
          <form key={b.status} action={action}>
            <input type="hidden" name="id" value={pkg.id} />
            <input type="hidden" name="status" value={b.status} />
            <SubmitButton variant={b.variant} pending="Saving…" className="w-fit">{b.label}</SubmitButton>
          </form>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------- departures ------------------------------- */

function DepartureFormBody({ packageId, d }: { packageId: string; d?: AdminDepartureDto }) {
  const [state, action] = useActionState(saveDepartureAction, initial);
  const f = state.fieldErrors ?? {};
  const v = (key: string, fallback: string | number | null | undefined = ''): string => state.values?.[key] ?? String(fallback ?? '');
  const price = (occ: string) => d?.prices.find((p) => p.occupancy === occ);
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="packageId" value={packageId} />
      {d && <input type="hidden" name="departureId" value={d.id} />}
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Departure date" required error={f.departureDate}><Input name="departureDate" type="date" defaultValue={v('departureDate', d?.departureDate)} /></FormField>
        <FormField label="Return date" required error={f.returnDate}><Input name="returnDate" type="date" defaultValue={v('returnDate', d?.returnDate)} /></FormField>
        <FormField label="Departing from" error={f.departureCity}><Input name="departureCity" defaultValue={v('departureCity', d?.departureCity)} /></FormField>
        <FormField label="Airline" error={f.airline}><Input name="airline" defaultValue={v('airline', d?.airline)} /></FormField>
        <FormField label="Seats in total" required error={f.seatsTotal} hint={d ? `${d.seatsReserved} already booked` : undefined}><Input name="seatsTotal" type="number" min={1} defaultValue={v('seatsTotal', d?.seatsTotal ?? 20)} /></FormField>
        <FormField label="Last day to book" error={f.bookingCutoffDate}><Input name="bookingCutoffDate" type="date" defaultValue={v('bookingCutoffDate', d?.bookingCutoffDate)} /></FormField>
        <FormField label="Status" error={f.status} hint="Only Open departures can be booked online.">
          <NativeSelect name="status" defaultValue={v('status', d?.status ?? 'OPEN')}>
            {['SCHEDULED', 'OPEN', 'CLOSED', 'SOLD_OUT', 'CANCELLED', 'COMPLETED'].map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ')}</option>)}
          </NativeSelect>
        </FormField>
        <FormField label="Flight details" error={f.flightDetails}><Input name="flightDetails" defaultValue={v('flightDetails', d?.flightDetails)} /></FormField>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Prices per person (PKR)</legend>
        <p className="text-xs text-muted-foreground">Leave the adult price empty for room types you do not offer. Child and infant prices are optional (child falls back to the adult price, infant to free). New prices apply to new bookings only.</p>
        {f.prices && <p role="alert" className="text-xs font-medium text-destructive">{f.prices}</p>}
        <div className="grid gap-2">
          {BOOKABLE_OCCUPANCIES.map((occ) => (
            <div key={occ} className="grid grid-cols-[5.5rem_1fr_1fr_1fr] items-center gap-2 text-sm">
              <span>{OCC_LABEL[occ]}</span>
              <Input name={`adult_${occ}`} inputMode="decimal" placeholder="Adult" aria-label={`${OCC_LABEL[occ]} adult price`} defaultValue={v(`adult_${occ}`, price(occ)?.adultPrice)} />
              <Input name={`child_${occ}`} inputMode="decimal" placeholder="Child" aria-label={`${OCC_LABEL[occ]} child price`} defaultValue={v(`child_${occ}`, price(occ)?.childPrice)} />
              <Input name={`infant_${occ}`} inputMode="decimal" placeholder="Infant" aria-label={`${OCC_LABEL[occ]} infant price`} defaultValue={v(`infant_${occ}`, price(occ)?.infantPrice)} />
            </div>
          ))}
        </div>
      </fieldset>
      <FormField label="Internal notes" error={f.notes}><Textarea name="notes" rows={2} defaultValue={v('notes', d?.notes)} /></FormField>
      <SubmitButton pending="Saving…" className="w-fit">{d ? 'Save departure' : 'Add departure'}</SubmitButton>
    </form>
  );
}

export function DepartureDialog({ packageId, departure, canEdit }: { packageId: string; departure?: AdminDepartureDto; canEdit: boolean }) {
  if (!canEdit) return null;
  return (
    <Dialog>
      <DialogTrigger asChild>
        {departure ? <Button variant="outline" size="sm"><Pencil /> Edit<span className="sr-only"> departure {departure.departureDate}</span></Button> : <Button variant="gold"><Plus /> Add departure</Button>}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{departure ? 'Edit departure' : 'Add a departure'}</DialogTitle>
          <DialogDescription>Dates, seats and prices for one trip.</DialogDescription>
        </DialogHeader>
        <DepartureFormBody packageId={packageId} d={departure} />
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDepartureButton({ packageId, departure }: { packageId: string; departure: AdminDepartureDto }) {
  const [state, action] = useActionState(deleteDepartureAction, initial);
  if (departure.bookings > 0) return null;
  return (
    <form action={action} className="grid gap-1">
      <input type="hidden" name="packageId" value={packageId} />
      <input type="hidden" name="departureId" value={departure.id} />
      <SubmitButton variant="outline" pending="Deleting…" className="w-fit text-destructive"><Trash2 /> Delete<span className="sr-only"> departure {departure.departureDate}</span></SubmitButton>
      {state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
    </form>
  );
}
