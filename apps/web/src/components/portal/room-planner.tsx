'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { Minus, Plus, Trash2 } from 'lucide-react';
import {
  BALANCE_DUE_DAYS_BEFORE_DEPARTURE,
  BOOKABLE_OCCUPANCIES,
  computeQuote,
  QUOTE_ERROR_MESSAGE,
  ROOM_CAPACITY,
  type DepartureOptionsDto,
  type Occupancy,
  type RoomRequest,
} from '@umrah/shared';
import { createBookingAction } from '@/app/(customer)/account/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { PriceSummary } from '@/components/commerce/price-summary';
import { FormField } from '@/components/forms/form-field';
import { NativeSelect } from '@/components/forms/native-select';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { formatMoney } from '@/lib/format';
import type { PortalFormState } from '@/lib/portal/forms';

const OCC_LABEL: Record<Occupancy, string> = { SINGLE: 'Single', DOUBLE: 'Double', TRIPLE: 'Triple', QUAD: 'Quad', QUINT: 'Quint', SHARING: 'Sharing' };
const initial: PortalFormState = {};

function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm" id={`${label}-lbl`}>{label}</span>
      <div className="flex items-center gap-2" role="group" aria-label={label}>
        <Button type="button" variant="outline" size="icon" className="size-8" disabled={value <= min} onClick={() => onChange(value - 1)} aria-label={`Fewer: ${label}`}><Minus /></Button>
        <output className="w-6 text-center font-medium tabular-nums" aria-live="polite">{value}</output>
        <Button type="button" variant="outline" size="icon" className="size-8" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label={`More: ${label}`}><Plus /></Button>
      </div>
    </div>
  );
}

/** Step 1 of a booking: choose rooms. The price shown is only a preview: the server prices the booking again when it is created. */
export function RoomPlanner({ options }: { options: DepartureOptionsDto }) {
  const available = BOOKABLE_OCCUPANCIES.filter((o) => options.prices[o]);
  const first = available.includes('DOUBLE') ? 'DOUBLE' : (available[0] as Occupancy);
  const [rooms, setRooms] = React.useState<RoomRequest[]>([{ occupancy: first, adults: Math.min(2, ROOM_CAPACITY[first]), children: 0, infants: 0 }]);
  const [state, action] = useActionState(createBookingAction, initial);

  const update = (i: number, patch: Partial<RoomRequest>) =>
    setRooms((rs) =>
      rs.map((r, idx) => {
        if (idx !== i) return r;
        const next = { ...r, ...patch };
        // Changing room type trims the party so it still fits the beds.
        const cap = ROOM_CAPACITY[next.occupancy];
        while (next.adults + next.children > cap) {
          if (next.children > 0) next.children -= 1;
          else next.adults -= 1;
        }
        return next;
      }),
    );

  const result = computeQuote(rooms, options.prices, options.deposit);
  const seatsNeeded = result.ok ? result.quote.seats : 0;
  const tooMany = result.ok && seatsNeeded > options.seatsLeft;
  const dueDate = new Date(Date.parse(`${options.departureDate}T00:00:00Z`) - BALANCE_DUE_DAYS_BEFORE_DEPARTURE * 86_400_000);
  const today = new Date();
  const balanceDue = (dueDate < today ? today : dueDate).toISOString().slice(0, 10);

  if (available.length === 0) return <p>No rooms are available on this departure.</p>;

  return (
    <form action={action} className="grid gap-8 lg:grid-cols-[1fr_22rem]" noValidate>
      <input type="hidden" name="departureId" value={options.departureId} />
      <input type="hidden" name="rooms" value={JSON.stringify(rooms)} />
      <div className="grid content-start gap-5">
        <FormMessage state={state} />
        {rooms.map((room, i) => {
          const cap = ROOM_CAPACITY[room.occupancy];
          const bedsUsed = room.adults + room.children;
          return (
            <Card key={i} className="gap-4 p-5" role="group" aria-label={`Room ${i + 1}`}>
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-display text-lg font-semibold">Room {i + 1}</h2>
                {rooms.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setRooms((rs) => rs.filter((_, idx) => idx !== i))}><Trash2 /> Remove</Button>}
              </div>
              <FormField label="Room type" hint={`${cap} bed${cap > 1 ? 's' : ''}. Infants share a bed.`}>
                <NativeSelect value={room.occupancy} onChange={(e) => update(i, { occupancy: e.target.value as Occupancy })}>
                  {available.map((o) => <option key={o} value={o}>{OCC_LABEL[o]} · {formatMoney(options.prices[o]!.adult, options.currency)} per adult</option>)}
                </NativeSelect>
              </FormField>
              <div className="grid gap-3">
                <Stepper label="Adults (12+)" value={room.adults} min={1} max={Math.max(1, cap - room.children)} onChange={(n) => update(i, { adults: n })} />
                <Stepper label="Children (2–11)" value={room.children} min={0} max={cap - room.adults} onChange={(n) => update(i, { children: n })} />
                <Stepper label="Infants (under 2)" value={room.infants} min={0} max={4} onChange={(n) => update(i, { infants: n })} />
              </div>
              {bedsUsed === cap && <p className="text-xs text-muted-foreground">This room is full.</p>}
            </Card>
          );
        })}
        <div>
          <Button type="button" variant="outline" onClick={() => setRooms((rs) => [...rs, { occupancy: first, adults: 1, children: 0, infants: 0 }])} disabled={rooms.length >= 15}><Plus /> Add another room</Button>
          <p className="mt-2 text-xs text-muted-foreground">Ages are counted on the return date, {options.returnDate}. You will choose the actual travelers next.</p>
        </div>
        <FormField label="Anything we should know? (optional)">
          <Textarea name="specialRequests" rows={3} placeholder="Wheelchair assistance, room near the lift, dietary needs…" maxLength={1000} />
        </FormField>
      </div>

      <div className="grid content-start gap-4 lg:sticky lg:top-24 lg:self-start">
        {result.ok ? (
          <PriceSummary
            currency={options.currency}
            lines={result.quote.rooms.map((r, i) => ({ label: `Room ${i + 1} · ${OCC_LABEL[r.occupancy]} (${r.adults}A${r.children ? ` ${r.children}C` : ''}${r.infants ? ` ${r.infants}I` : ''})`, amount: r.lineTotal }))}
            total={result.quote.grandTotal}
            dueNow={result.quote.depositAmount}
            balance={result.quote.balanceAmount}
            balanceDueDate={balanceDue}
          />
        ) : (
          <Card className="p-5 text-sm" role="status">{QUOTE_ERROR_MESSAGE(result.error)}</Card>
        )}
        {tooMany && <p role="alert" className="text-sm font-medium text-destructive">Only {options.seatsLeft} seat(s) left on this departure.</p>}
        <SubmitButton pending="Reserving seats…">Continue to travelers</SubmitButton>
        <p className="text-xs text-muted-foreground">We hold your seats for 60 minutes while you complete the booking. Nothing is charged yet.</p>
      </div>
    </form>
  );
}
