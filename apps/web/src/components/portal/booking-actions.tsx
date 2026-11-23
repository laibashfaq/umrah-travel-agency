'use client';

import { useActionState } from 'react';
import { Send, XCircle } from 'lucide-react';
import { cancelBookingAction, submitBookingAction } from '@/app/(customer)/account/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { PortalFormState } from '@/lib/portal/forms';

const initial: PortalFormState = {};

export function SubmitBooking({ bookingId, ready }: { bookingId: string; ready: boolean }) {
  const [state, action] = useActionState(submitBookingAction, initial);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="bookingId" value={bookingId} />
      <FormMessage state={state} />
      {ready ? (
        <SubmitButton pending="Submitting…" className="w-auto"><Send /> Submit booking</SubmitButton>
      ) : (
        <Button type="button" size="lg" disabled className="w-fit"><Send /> Submit booking</Button>
      )}
      <p className="text-xs text-muted-foreground">Submitting confirms your seats and sends your booking to our team. Payment instructions follow; nothing is charged by submitting.</p>
    </form>
  );
}

export function CancelBooking({ bookingId, reference }: { bookingId: string; reference: string }) {
  const [state, action] = useActionState(cancelBookingAction, initial);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="text-destructive"><XCircle /> Cancel booking</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel booking {reference}?</DialogTitle>
          <DialogDescription>Your seats are released straight away. This cannot be undone, but you can book again if seats are available.</DialogDescription>
        </DialogHeader>
        <form action={action} className="grid gap-4">
          <input type="hidden" name="bookingId" value={bookingId} />
          <FormMessage state={state} />
          <label className="grid gap-1.5 text-sm font-medium">
            Reason (optional)
            <Textarea name="reason" rows={3} maxLength={500} />
          </label>
          <DialogFooter>
            <SubmitButton variant="destructive" pending="Cancelling…" className="w-auto">Yes, cancel booking</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
