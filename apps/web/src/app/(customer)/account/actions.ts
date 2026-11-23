'use server';

import { redirect } from 'next/navigation';
import {
  bookingCreateSchema,
  bookingTravelersSchema,
  MAX_DOCUMENT_BYTES,
  uploadQuerySchema,
  profileUpdateSchema,
  reportPaymentSchema,
  travelerInputSchema,
  type BookingDetailDto,
} from '@umrah/shared';
import { requireUser, uploadAsUser } from '@/lib/auth/server';
import { portal } from '@/lib/portal/api';
import { apiFail, snapshot, str, zodFail, type PortalFormState } from '@/lib/portal/forms';
import { safeNextPath } from '@/lib/auth/config';

const checked = (fd: FormData, key: string) => fd.get(key) === 'on';
const blankToUndefined = (v: string) => (v.trim() === '' ? undefined : v);

/* -------------------------------- profile -------------------------------- */

export async function saveProfileAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('CUSTOMER');
  const values = snapshot(fd);
  const parsed = profileUpdateSchema.safeParse({
    firstName: str(fd, 'firstName'),
    lastName: str(fd, 'lastName'),
    phone: str(fd, 'phone'),
    whatsappNumber: str(fd, 'whatsappNumber'),
    whatsappOptIn: checked(fd, 'whatsappOptIn'),
    marketingOptIn: checked(fd, 'marketingOptIn'),
    country: str(fd, 'country'),
    city: str(fd, 'city'),
    addressLine: str(fd, 'addressLine'),
    preferredLanguage: str(fd, 'preferredLanguage') || 'en',
  });
  if (!parsed.success) return zodFail(parsed.error.issues, values);
  const res = await portal('/profile', { method: 'PUT', body: parsed.data });
  return res.ok ? { ok: true, message: 'Your profile was saved.', values } : apiFail(res.error, values);
}

/* ------------------------------- travelers ------------------------------- */

const TRAVELER_FIELDS = [
  'relationship', 'title', 'firstName', 'middleName', 'lastName', 'fatherOrHusbandName', 'gender', 'dateOfBirth', 'placeOfBirth',
  'nationality', 'passportNumber', 'passportIssuingCountry', 'passportIssueDate', 'passportExpiryDate', 'nationalId', 'phone', 'email',
  'mahramTravelerId', 'mahramRelationship', 'specialRequirements',
] as const;

/** Creates (no `id`) or updates a saved traveler, then returns to where the customer came from. */
export async function saveTravelerAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('CUSTOMER');
  const id = str(fd, 'id');
  // Identity numbers are deliberately not echoed back into the form after an error.
  const values = snapshot(fd, ['passportNumber', 'nationalId', 'id', 'returnTo']);
  const raw: Record<string, string> = {};
  for (const f of TRAVELER_FIELDS) raw[f] = str(fd, f);
  const parsed = travelerInputSchema.safeParse(raw);
  if (!parsed.success) return zodFail(parsed.error.issues, values);

  const res = await portal(id ? `/travelers/${encodeURIComponent(id)}` : '/travelers', { method: id ? 'PUT' : 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, values);
  redirect(safeNextPath(str(fd, 'returnTo'), '/account/travelers'));
}

export async function deleteTravelerAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('CUSTOMER');
  const res = await portal(`/travelers/${encodeURIComponent(str(fd, 'id'))}`, { method: 'DELETE' });
  if (!res.ok) return apiFail(res.error);
  redirect('/account/travelers');
}

/* -------------------------------- bookings -------------------------------- */

export async function createBookingAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('CUSTOMER');
  let rooms: unknown;
  try {
    rooms = JSON.parse(str(fd, 'rooms'));
  } catch {
    return { error: 'Please choose your rooms again.' };
  }
  const parsed = bookingCreateSchema.safeParse({ departureId: str(fd, 'departureId'), rooms, specialRequests: str(fd, 'specialRequests') });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check your room selection.' };
  const res = await portal<BookingDetailDto>('/bookings', { method: 'POST', body: parsed.data });
  if (!res.ok) return { error: res.error.message };
  redirect(`/account/bookings/${res.data.id}`);
}

export async function saveBookingTravelersAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('CUSTOMER');
  const id = str(fd, 'bookingId');
  let assignments: unknown;
  try {
    assignments = JSON.parse(str(fd, 'assignments'));
  } catch {
    return { error: 'Please choose your travelers again.' };
  }
  const parsed = bookingTravelersSchema.safeParse({ assignments, leadTravelerId: str(fd, 'leadTravelerId'), specialRequests: blankToUndefined(str(fd, 'specialRequests')) });
  if (!parsed.success) return { error: 'Choose a traveler for every place and a lead traveler.' };
  const res = await portal(`/bookings/${encodeURIComponent(id)}/travelers`, { method: 'PUT', body: parsed.data });
  if (!res.ok) return { error: res.error.message };
  redirect(`/account/bookings/${id}?saved=1`);
}

export async function submitBookingAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('CUSTOMER');
  const id = str(fd, 'bookingId');
  const res = await portal(`/bookings/${encodeURIComponent(id)}/submit`, { method: 'POST' });
  if (!res.ok) return { error: res.error.message };
  redirect(`/account/bookings/${id}?submitted=1`);
}

export async function cancelBookingAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('CUSTOMER');
  const id = str(fd, 'bookingId');
  const res = await portal(`/bookings/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { reason: blankToUndefined(str(fd, 'reason')) } });
  if (!res.ok) return { error: res.error.message };
  redirect(`/account/bookings/${id}`);
}

/* -------------------------------- payments -------------------------------- */

export async function reportPaymentAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('CUSTOMER');
  const bookingId = str(fd, 'bookingId');
  const values = snapshot(fd, ['bookingId']);
  const parsed = reportPaymentSchema.safeParse({
    bookingId,
    method: str(fd, 'method'),
    amount: str(fd, 'amount'),
    paidOn: str(fd, 'paidOn'),
    transactionRef: str(fd, 'transactionRef'),
    note: str(fd, 'note'),
  });
  if (!parsed.success) return zodFail(parsed.error.issues, values);
  const res = await portal('/payments', { method: 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, values);
  redirect(`/account/bookings/${bookingId}?paymentReported=1`);
}

/* -------------------------------- documents -------------------------------- */

export async function uploadDocumentAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('CUSTOMER');
  const file = fd.get('file');
  const values = { type: str(fd, 'type'), travelerId: str(fd, 'travelerId') };
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a file to upload.', fieldErrors: { file: 'Choose a file' }, values };
  if (file.size > MAX_DOCUMENT_BYTES) return { error: 'That file is larger than 5 MB.', fieldErrors: { file: 'Up to 5 MB' }, values };
  const parsed = uploadQuerySchema.safeParse({ type: str(fd, 'type'), travelerId: str(fd, 'travelerId'), bookingId: str(fd, 'bookingId'), fileName: file.name || 'document' });
  if (!parsed.success) return zodFail(parsed.error.issues, values);
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) query.set(k, String(v));
  const res = await uploadAsUser(`/me/documents?${query.toString()}`, await file.arrayBuffer());
  if (!res.ok) return apiFail(res.error, values);
  redirect('/account/documents?uploaded=1');
}

export async function deleteDocumentAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('CUSTOMER');
  const res = await portal(`/documents/${encodeURIComponent(str(fd, 'id'))}`, { method: 'DELETE' });
  if (!res.ok) return apiFail(res.error);
  redirect('/account/documents?removed=1');
}
