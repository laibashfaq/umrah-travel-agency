'use client';

import { useActionState } from 'react';
import { saveProfileAction } from '@/app/(customer)/account/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { FormField } from '@/components/forms/form-field';
import { NativeSelect } from '@/components/forms/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { COUNTRIES } from '@/lib/countries';
import type { PortalFormState } from '@/lib/portal/forms';
import type { ProfileDto } from '@umrah/shared';

const initial: PortalFormState = {};

export function ProfileForm({ profile }: { profile: ProfileDto }) {
  const [state, action] = useActionState(saveProfileAction, initial);
  const f = state.fieldErrors ?? {};
  const v = (key: keyof ProfileDto): string => state.values?.[key] ?? (profile[key] as string | null) ?? '';
  return (
    <form action={action} className="grid max-w-2xl gap-6" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="First name" required error={f.firstName}><Input name="firstName" autoComplete="given-name" defaultValue={v('firstName')} /></FormField>
        <FormField label="Last name" required error={f.lastName}><Input name="lastName" autoComplete="family-name" defaultValue={v('lastName')} /></FormField>
        <FormField label="Email" hint="Your sign-in address. Contact us to change it."><Input value={profile.email} readOnly disabled /></FormField>
        <FormField label="Phone" error={f.phone}><Input name="phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="+92 300 1234567" defaultValue={v('phone')} /></FormField>
        <FormField label="WhatsApp number" error={f.whatsappNumber} hint="If different from your phone."><Input name="whatsappNumber" type="tel" inputMode="tel" defaultValue={v('whatsappNumber')} /></FormField>
        <FormField label="Preferred language" error={f.preferredLanguage}>
          <NativeSelect name="preferredLanguage" defaultValue={v('preferredLanguage') || 'en'}>
            <option value="en">English</option>
            <option value="ur">اردو (Urdu)</option>
            <option value="ar">العربية (Arabic)</option>
          </NativeSelect>
        </FormField>
        <FormField label="Country" error={f.country}>
          <NativeSelect name="country" defaultValue={v('country')}>
            <option value="">Select…</option>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </NativeSelect>
        </FormField>
        <FormField label="City" error={f.city}><Input name="city" autoComplete="address-level2" defaultValue={v('city')} /></FormField>
        <FormField label="Address" className="sm:col-span-2" error={f.addressLine}><Input name="addressLine" autoComplete="street-address" defaultValue={v('addressLine')} /></FormField>
      </div>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Messages</legend>
        <div className="flex items-start gap-3">
          <Checkbox id="whatsappOptIn" name="whatsappOptIn" defaultChecked={state.values ? state.values.whatsappOptIn === 'on' : profile.whatsappOptIn} />
          <Label htmlFor="whatsappOptIn" className="font-normal leading-snug">Send me booking updates on WhatsApp</Label>
        </div>
        <div className="flex items-start gap-3">
          <Checkbox id="marketingOptIn" name="marketingOptIn" defaultChecked={state.values ? state.values.marketingOptIn === 'on' : profile.marketingOptIn} />
          <Label htmlFor="marketingOptIn" className="font-normal leading-snug">Email me offers and new departures (you can unsubscribe any time)</Label>
        </div>
        <p className="text-xs text-muted-foreground">Booking confirmations and security emails are always sent.</p>
      </fieldset>

      <SubmitButton pending="Saving…" className="w-auto">Save profile</SubmitButton>
    </form>
  );
}
