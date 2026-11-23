'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  BOOKABLE_OCCUPANCIES,
  bookingStatusChangeSchema,
  departureInputSchema,
  documentReviewSchema,
  visaUpdateSchema,
  noteSchema,
  packageInputSchema,
  recordPaymentSchema,
  refundActionSchema,
  requestRefundSchema,
  verifyPaymentSchema,
  voidInvoiceSchema,
  type AdminPackageDetailDto,
} from '@umrah/shared';
import { admin } from '@/lib/admin/api';
import { safeNextPath } from '@/lib/auth/config';
import { requireUser } from '@/lib/auth/server';
import { apiFail, snapshot, str, zodFail, type PortalFormState } from '@/lib/portal/forms';

/** Public pages cache API data for up to a minute; a staff edit should show on the website straight away. */
const refreshPublicSite = () => revalidatePath('/', 'layout');
/** Sends the staff member back to the list they were on, with a message that survives the row disappearing. */
function backWithNotice(fd: FormData, fallback: string, notice: string): never {
  const target = safeNextPath(str(fd, 'returnTo'), fallback);
  redirect(`${target}${target.includes('?') ? '&' : '?'}notice=${encodeURIComponent(notice)}`);
}
const on = (fd: FormData, key: string) => fd.get(key) === 'on';
const blankToNull = (v: string) => (v.trim() === '' ? null : v.trim());

/* -------------------------------- bookings -------------------------------- */

export async function changeBookingStatusAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const id = str(fd, 'bookingId');
  const parsed = bookingStatusChangeSchema.safeParse({ toStatus: str(fd, 'toStatus'), note: str(fd, 'note') });
  if (!parsed.success) return zodFail(parsed.error.issues, snapshot(fd));
  const res = await admin(`/bookings/${encodeURIComponent(id)}/status`, { method: 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, snapshot(fd));
  redirect(`/admin/bookings/${id}?updated=1`);
}

export async function assignBookingAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const id = str(fd, 'bookingId');
  const res = await admin(`/bookings/${encodeURIComponent(id)}/assign`, { method: 'POST', body: { assignedToId: blankToNull(str(fd, 'assignedToId')) } });
  if (!res.ok) return apiFail(res.error);
  revalidatePath(`/admin/bookings/${id}`);
  return { ok: true, message: 'Assignment saved.' };
}

export async function addNoteAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const target = str(fd, 'target') === 'customer' ? 'customers' : 'bookings';
  const id = str(fd, 'id');
  const parsed = noteSchema.safeParse({ body: str(fd, 'body') });
  if (!parsed.success) return zodFail(parsed.error.issues);
  const res = await admin(`/${target}/${encodeURIComponent(id)}/notes`, { method: 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error);
  revalidatePath(`/admin/${target}/${id}`);
  return { ok: true, message: 'Note added.' };
}

/* -------------------------------- packages -------------------------------- */

function packageFromForm(fd: FormData) {
  return {
    title: str(fd, 'title'),
    slug: str(fd, 'slug'),
    subtitle: str(fd, 'subtitle'),
    summary: str(fd, 'summary'),
    description: str(fd, 'description'),
    tier: str(fd, 'tier'),
    durationDays: str(fd, 'durationDays'),
    nightsMakkah: str(fd, 'nightsMakkah') || '0',
    nightsMadinah: str(fd, 'nightsMadinah') || '0',
    departureCities: str(fd, 'departureCities'),
    mealPlan: str(fd, 'mealPlan'),
    inclusions: str(fd, 'inclusions'),
    exclusions: str(fd, 'exclusions'),
    terms: str(fd, 'terms'),
    visaIncluded: on(fd, 'visaIncluded'),
    flightIncluded: on(fd, 'flightIncluded'),
    transportIncluded: on(fd, 'transportIncluded'),
    ziyaratIncluded: on(fd, 'ziyaratIncluded'),
    depositType: str(fd, 'depositType'),
    depositValue: str(fd, 'depositValue'),
    isFeatured: on(fd, 'isFeatured'),
    seoTitle: str(fd, 'seoTitle'),
    seoDescription: str(fd, 'seoDescription'),
  };
}

export async function savePackageAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const id = str(fd, 'id');
  const values = snapshot(fd, ['id']);
  const parsed = packageInputSchema.safeParse(packageFromForm(fd));
  if (!parsed.success) return zodFail(parsed.error.issues, values);
  // The schema turns the textarea lines into arrays; send the parsed (validated) object.
  const res = await admin<AdminPackageDetailDto>(id ? `/packages/${encodeURIComponent(id)}` : '/packages', { method: id ? 'PUT' : 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, values);
  refreshPublicSite();
  if (!id) redirect(`/admin/packages/${res.data.id}?created=1`);
  return { ok: true, message: 'Package saved.', values };
}

export async function setPackageStatusAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const id = str(fd, 'id');
  const res = await admin(`/packages/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status: str(fd, 'status') } });
  if (!res.ok) return apiFail(res.error);
  refreshPublicSite();
  redirect(`/admin/packages/${id}?updated=1`);
}

/* ------------------------------- departures ------------------------------- */

export async function saveDepartureAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const packageId = str(fd, 'packageId');
  const departureId = str(fd, 'departureId');
  const values = snapshot(fd, ['packageId', 'departureId']);
  const prices = BOOKABLE_OCCUPANCIES.flatMap((occupancy) => {
    const adultPrice = str(fd, `adult_${occupancy}`).trim();
    return adultPrice ? [{ occupancy, adultPrice, childPrice: str(fd, `child_${occupancy}`), infantPrice: str(fd, `infant_${occupancy}`) }] : [];
  });
  const parsed = departureInputSchema.safeParse({
    departureDate: str(fd, 'departureDate'),
    returnDate: str(fd, 'returnDate'),
    departureCity: str(fd, 'departureCity'),
    airline: str(fd, 'airline'),
    flightDetails: str(fd, 'flightDetails'),
    seatsTotal: str(fd, 'seatsTotal'),
    bookingCutoffDate: str(fd, 'bookingCutoffDate'),
    status: str(fd, 'status'),
    notes: str(fd, 'notes'),
    prices,
  });
  if (!parsed.success) return zodFail(parsed.error.issues.map((i) => ({ ...i, path: i.path[0] === 'prices' ? ['prices'] : i.path })), values);
  const path = departureId ? `/packages/${encodeURIComponent(packageId)}/departures/${encodeURIComponent(departureId)}` : `/packages/${encodeURIComponent(packageId)}/departures`;
  const res = await admin(path, { method: departureId ? 'PUT' : 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, values);
  refreshPublicSite();
  redirect(`/admin/packages/${packageId}?updated=1`);
}

export async function deleteDepartureAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const packageId = str(fd, 'packageId');
  const res = await admin(`/packages/${encodeURIComponent(packageId)}/departures/${encodeURIComponent(str(fd, 'departureId'))}`, { method: 'DELETE' });
  if (!res.ok) return apiFail(res.error);
  refreshPublicSite();
  redirect(`/admin/packages/${packageId}?updated=1`);
}

/* -------------------------------- finance -------------------------------- */

export async function recordPaymentAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const bookingId = str(fd, 'bookingId');
  const values = snapshot(fd, ['bookingId']);
  const parsed = recordPaymentSchema.safeParse({ bookingId, method: str(fd, 'method'), amount: str(fd, 'amount'), paidOn: str(fd, 'paidOn'), transactionRef: str(fd, 'transactionRef'), note: str(fd, 'note') });
  if (!parsed.success) return zodFail(parsed.error.issues, values);
  const res = await admin('/payments', { method: 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, values);
  revalidatePath(`/admin/bookings/${bookingId}`);
  redirect(`/admin/bookings/${bookingId}?updated=1`);
}

export async function verifyPaymentAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const parsed = verifyPaymentSchema.safeParse({ decision: str(fd, 'decision'), note: str(fd, 'note') });
  if (!parsed.success) return zodFail(parsed.error.issues, snapshot(fd));
  const res = await admin(`/payments/${encodeURIComponent(str(fd, 'paymentId'))}/verify`, { method: 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, snapshot(fd));
  revalidatePath('/admin/payments');
  backWithNotice(fd, '/admin/payments', parsed.data.decision === 'APPROVE' ? 'Payment verified.' : 'Payment rejected.');
}

export async function requestRefundAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const values = snapshot(fd, ['paymentId']);
  const parsed = requestRefundSchema.safeParse({ paymentId: str(fd, 'paymentId'), amount: str(fd, 'amount'), reason: str(fd, 'reason') });
  if (!parsed.success) return zodFail(parsed.error.issues, values);
  const res = await admin('/refunds', { method: 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, values);
  revalidatePath('/admin/refunds');
  return { ok: true, message: 'Refund requested. Someone else must approve it.' };
}

export async function refundAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const parsed = refundActionSchema.safeParse({ action: str(fd, 'action'), note: str(fd, 'note') });
  if (!parsed.success) return zodFail(parsed.error.issues, snapshot(fd));
  const res = await admin(`/refunds/${encodeURIComponent(str(fd, 'refundId'))}/action`, { method: 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, snapshot(fd));
  revalidatePath('/admin/refunds');
  backWithNotice(fd, '/admin/refunds', 'Refund updated.');
}

export async function issueInvoiceAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const bookingId = str(fd, 'bookingId');
  const res = await admin(`/bookings/${encodeURIComponent(bookingId)}/invoice`, { method: 'POST' });
  if (!res.ok) return apiFail(res.error);
  revalidatePath(`/admin/bookings/${bookingId}`);
  redirect(`/admin/bookings/${bookingId}?updated=1`);
}

export async function voidInvoiceAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const id = str(fd, 'invoiceId');
  const parsed = voidInvoiceSchema.safeParse({ reason: str(fd, 'reason') });
  if (!parsed.success) return zodFail(parsed.error.issues, snapshot(fd));
  const res = await admin(`/invoices/${encodeURIComponent(id)}/void`, { method: 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, snapshot(fd));
  revalidatePath(`/admin/invoices/${id}`);
  redirect(`/admin/invoices/${id}?updated=1`);
}

/* --------------------------- documents and visas --------------------------- */

export async function reviewDocumentAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const parsed = documentReviewSchema.safeParse({ decision: str(fd, 'decision'), reason: str(fd, 'reason'), expiresAt: str(fd, 'expiresAt') });
  if (!parsed.success) return zodFail(parsed.error.issues, snapshot(fd));
  const res = await admin(`/documents/${encodeURIComponent(str(fd, 'documentId'))}/review`, { method: 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, snapshot(fd));
  revalidatePath('/admin/documents');
  backWithNotice(fd, '/admin/documents', parsed.data.decision === 'APPROVE' ? 'Document approved.' : 'Document rejected.');
}

export async function startVisasAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const bookingId = str(fd, 'bookingId');
  const res = await admin(`/bookings/${encodeURIComponent(bookingId)}/visas`, { method: 'POST' });
  if (!res.ok) return apiFail(res.error);
  revalidatePath(`/admin/bookings/${bookingId}`);
  redirect(`/admin/bookings/${bookingId}?updated=1`);
}

export async function changeVisaStatusAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const id = str(fd, 'visaId');
  const values = snapshot(fd, ['visaId']);
  const parsed = visaUpdateSchema.safeParse({
    toStatus: str(fd, 'toStatus'),
    note: str(fd, 'note'),
    applicationNumber: str(fd, 'applicationNumber'),
    externalReference: str(fd, 'externalReference'),
    visaNumber: str(fd, 'visaNumber'),
    validFrom: str(fd, 'validFrom'),
    validUntil: str(fd, 'validUntil'),
    rejectionReason: str(fd, 'rejectionReason'),
  });
  if (!parsed.success) return zodFail(parsed.error.issues, values);
  const res = await admin(`/visas/${encodeURIComponent(id)}/status`, { method: 'POST', body: parsed.data });
  if (!res.ok) return apiFail(res.error, values);
  revalidatePath(`/admin/visas/${id}`);
  redirect(`/admin/visas/${id}?updated=1`);
}

export async function assignVisaAction(_prev: PortalFormState, fd: FormData): Promise<PortalFormState> {
  await requireUser('STAFF');
  const id = str(fd, 'visaId');
  const res = await admin(`/visas/${encodeURIComponent(id)}/assign`, { method: 'POST', body: { assignedOfficerId: blankToNull(str(fd, 'assignedOfficerId')) } });
  if (!res.ok) return apiFail(res.error);
  revalidatePath(`/admin/visas/${id}`);
  return { ok: true, message: 'Assignment saved.' };
}
