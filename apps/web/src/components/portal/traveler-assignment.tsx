'use client';

import * as React from 'react';
import { useActionState } from 'react';
import Link from 'next/link';
import { UserPlus } from 'lucide-react';
import { travelerKindFor, type BookingDetailDto, type TravelerDto, type TravelerKind } from '@umrah/shared';
import { saveBookingTravelersAction } from '@/app/(customer)/account/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { FormField } from '@/components/forms/form-field';
import { NativeSelect } from '@/components/forms/native-select';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatDate } from '@/lib/format';
import type { PortalFormState } from '@/lib/portal/forms';
import { cn } from '@/lib/utils';

const initial: PortalFormState = {};
const KIND_LABEL: Record<TravelerKind, string> = { ADULT: 'Adult', CHILD: 'Child (2–11)', INFANT: 'Infant (under 2)' };

interface Slot {
  key: string;
  roomIndex: number;
  kind: TravelerKind;
  travelerId: string;
}

function buildSlots(booking: BookingDetailDto): Slot[] {
  const slots: Slot[] = [];
  for (const room of booking.rooms) {
    const saved = booking.travelerList.filter((t) => t.roomIndex === room.index);
    const take = (kind: TravelerKind, count: number) => {
      const have = saved.filter((t) => t.kind === kind);
      for (let n = 0; n < count; n++) slots.push({ key: `${room.index}-${kind}-${n}`, roomIndex: room.index, kind, travelerId: have[n]?.travelerId ?? '' });
    };
    take('ADULT', room.adults);
    take('CHILD', room.children);
    take('INFANT', room.infants);
  }
  return slots;
}

/** Step 2: choose which saved traveler goes in which place. The server checks ages, rooms and ownership again. */
export function TravelerAssignment({ booking, travelers }: { booking: BookingDetailDto; travelers: TravelerDto[] }) {
  const [state, action] = useActionState(saveBookingTravelersAction, initial);
  const [slots, setSlots] = React.useState<Slot[]>(() => buildSlots(booking));
  const [lead, setLead] = React.useState(() => booking.travelerList.find((t) => t.isLead)?.travelerId ?? '');

  const kindOf = React.useMemo(() => new Map(travelers.map((t) => [t.id, travelerKindFor(t.dateOfBirth, booking.returnDate)])), [travelers, booking.returnDate]);
  const chosen = new Set(slots.map((s) => s.travelerId).filter(Boolean));
  const complete = slots.every((s) => s.travelerId);
  const leadValid = complete && slots.some((s) => s.travelerId === lead && s.kind === 'ADULT');
  const effectiveLead = leadValid ? lead : (slots.find((s) => s.kind === 'ADULT' && s.travelerId)?.travelerId ?? '');
  const here = `/account/bookings/${booking.id}`;
  const addHref = `/account/travelers/new?returnTo=${encodeURIComponent(here)}`;

  const set = (key: string, travelerId: string) => setSlots((ss) => ss.map((s) => (s.key === key ? { ...s, travelerId } : s)));

  return (
    <form action={action} className="grid gap-6" noValidate>
      <input type="hidden" name="bookingId" value={booking.id} />
      <input type="hidden" name="assignments" value={JSON.stringify(slots.filter((s) => s.travelerId).map((s) => ({ roomIndex: s.roomIndex, travelerId: s.travelerId })))} />
      <input type="hidden" name="leadTravelerId" value={effectiveLead} />
      <FormMessage state={state} />

      {booking.rooms.map((room) => (
        <fieldset key={room.index} className="grid gap-3 rounded-xl border p-4">
          <legend className="px-1 font-display font-semibold">Room {room.index + 1} · {room.occupancy.charAt(0) + room.occupancy.slice(1).toLowerCase()}</legend>
          {slots.filter((s) => s.roomIndex === room.index).map((s, _i, inRoom) => {
            const n = inRoom.filter((x) => x.kind === s.kind).indexOf(s);
            const eligible = travelers.filter((t) => kindOf.get(t.id) === s.kind && (t.id === s.travelerId || !chosen.has(t.id)));
            return (
              <div key={s.key} className="grid items-end gap-3 sm:grid-cols-[1fr_auto]">
                <FormField label={`${KIND_LABEL[s.kind]} ${n + 1}`} hint={eligible.length === 0 ? `No saved traveler is ${s.kind === 'ADULT' ? 'an adult' : s.kind === 'CHILD' ? 'aged 2–11' : 'under 2'} on ${formatDate(booking.returnDate)}. Add one.` : undefined}>
                  <NativeSelect value={s.travelerId} onChange={(e) => set(s.key, e.target.value)}>
                    <option value="">Choose a traveler…</option>
                    {eligible.map((t) => <option key={t.id} value={t.id}>{t.firstName} {t.lastName}{t.passportNumberMasked ? '' : ' (no passport yet)'}</option>)}
                  </NativeSelect>
                </FormField>
                {s.kind === 'ADULT' && s.travelerId && (
                  <label className={cn('flex h-9 items-center gap-2 text-sm', effectiveLead === s.travelerId && 'font-medium')}>
                    <input type="radio" name="leadChoice" checked={effectiveLead === s.travelerId} onChange={() => setLead(s.travelerId)} className="size-4 accent-primary" />
                    Lead traveler
                  </label>
                )}
              </div>
            );
          })}
        </fieldset>
      ))}

      <FormField label="Special requests (optional)">
        <Textarea name="specialRequests" rows={3} defaultValue={booking.specialRequests ?? ''} maxLength={1000} />
      </FormField>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending="Saving…" className="w-auto">Save travelers</SubmitButton>
        <Button asChild variant="outline"><Link href={addHref}><UserPlus /> Add a new traveler</Link></Button>
      </div>
      <p className="text-xs text-muted-foreground">Each traveler needs a passport number and expiry date (valid 6 months after {formatDate(booking.returnDate)}) before you can submit. Age groups are counted on the return date.</p>
    </form>
  );
}
