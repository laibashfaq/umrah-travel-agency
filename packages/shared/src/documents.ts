import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export const DOCUMENT_TYPES = [
  'PASSPORT',
  'NATIONAL_ID',
  'PHOTO',
  'VACCINATION_CERTIFICATE',
  'MAHRAM_PROOF',
  'MARRIAGE_CERTIFICATE',
  'BIRTH_CERTIFICATE',
  'PAYMENT_PROOF',
  'OTHER',
] as const;
export type DocumentTypeKey = (typeof DOCUMENT_TYPES)[number];

/** Types staff attach themselves (the customer cannot upload a visa or a ticket). */
export const STAFF_DOCUMENT_TYPES = [...DOCUMENT_TYPES, 'VISA', 'FLIGHT_TICKET', 'HOTEL_VOUCHER', 'TRAVEL_ITINERARY'] as const;

export const DOCUMENT_LABEL: Record<string, string> = {
  PASSPORT: 'Passport (photo page)',
  NATIONAL_ID: 'CNIC / national ID',
  PHOTO: 'Passport-style photo',
  VACCINATION_CERTIFICATE: 'Vaccination certificate',
  MAHRAM_PROOF: 'Mahram proof',
  MARRIAGE_CERTIFICATE: 'Marriage certificate',
  BIRTH_CERTIFICATE: 'Birth certificate',
  PAYMENT_PROOF: 'Payment proof',
  VISA: 'Visa',
  FLIGHT_TICKET: 'Flight ticket',
  HOTEL_VOUCHER: 'Hotel voucher',
  TRAVEL_ITINERARY: 'Travel itinerary',
  OTHER: 'Other document',
};

/** Needed for every traveler before a visa application can be submitted. */
export const REQUIRED_TRAVELER_DOCUMENTS = ['PASSPORT', 'PHOTO'] as const;

export const ALLOWED_DOCUMENT_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const;

const blank = (v: unknown) => (v === '' || v === null ? undefined : v);

/** Upload metadata travels in the query string; the file itself is the raw request body. */
export const uploadQuerySchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  travelerId: z.preprocess(blank, z.string().uuid().optional()),
  bookingId: z.preprocess(blank, z.string().uuid().optional()),
  fileName: z.string().trim().min(1).max(160),
});
export type UploadQuery = z.infer<typeof uploadQuerySchema>;

export const staffUploadQuerySchema = uploadQuerySchema.extend({
  type: z.enum(STAFF_DOCUMENT_TYPES),
  travelerId: z.string().uuid(),
  bookingId: z.preprocess(blank, z.string().uuid().optional()),
  /** Staff can attach a file straight to an application. */
  visaApplicationId: z.preprocess(blank, z.string().uuid().optional()),
});

export const documentReviewSchema = z
  .object({ decision: z.enum(['APPROVE', 'REJECT']), reason: z.preprocess(blank, z.string().trim().max(300).optional()), expiresAt: z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()) })
  .refine((v) => v.decision === 'APPROVE' || Boolean(v.reason), { message: 'Tell the customer what to fix', path: ['reason'] });
export type DocumentReviewInput = z.infer<typeof documentReviewSchema>;

export const adminDocumentQuery = z.object({
  status: z.preprocess(blank, z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED']).optional()),
  type: z.preprocess(blank, z.enum(STAFF_DOCUMENT_TYPES).optional()),
  q: z.preprocess(blank, z.string().trim().max(100).optional()),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface DocumentDto {
  id: string;
  type: string;
  status: string;
  travelerId: string | null;
  travelerName: string | null;
  customerName: string | null;
  bookingId: string | null;
  bookingReference: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  rejectionReason: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  expiresAt: string | null;
  uploadedByStaff: boolean;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Visa applications                                                   */
/* ------------------------------------------------------------------ */

export const VISA_STATUSES = ['NOT_STARTED', 'DOCUMENTS_PENDING', 'UNDER_REVIEW', 'READY_TO_SUBMIT', 'SUBMITTED', 'IN_PROCESS', 'APPROVED', 'ISSUED', 'REJECTED', 'CANCELLED'] as const;
export type VisaStatusKey = (typeof VISA_STATUSES)[number];

export const VISA_TRANSITIONS: Record<VisaStatusKey, readonly VisaStatusKey[]> = {
  NOT_STARTED: ['DOCUMENTS_PENDING', 'CANCELLED'],
  DOCUMENTS_PENDING: ['UNDER_REVIEW', 'CANCELLED'],
  UNDER_REVIEW: ['READY_TO_SUBMIT', 'DOCUMENTS_PENDING', 'REJECTED', 'CANCELLED'],
  READY_TO_SUBMIT: ['SUBMITTED', 'DOCUMENTS_PENDING', 'CANCELLED'],
  SUBMITTED: ['IN_PROCESS', 'REJECTED', 'CANCELLED'],
  IN_PROCESS: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['ISSUED', 'CANCELLED'],
  ISSUED: [],
  REJECTED: ['DOCUMENTS_PENDING'],
  CANCELLED: [],
};

export const canTransitionVisa = (from: VisaStatusKey, to: VisaStatusKey): boolean => VISA_TRANSITIONS[from].includes(to);

/** What the customer is told at each step, in plain words. */
export const VISA_CUSTOMER_MESSAGE: Record<VisaStatusKey, string> = {
  NOT_STARTED: 'We will start your visa application soon.',
  DOCUMENTS_PENDING: 'We need your documents. Upload your passport and photo.',
  UNDER_REVIEW: 'We are checking your documents.',
  READY_TO_SUBMIT: 'Your documents are approved. We are about to submit your application.',
  SUBMITTED: 'Your application has been submitted.',
  IN_PROCESS: 'Your application is being processed by the authorities.',
  APPROVED: 'Your visa is approved. We are preparing it for you.',
  ISSUED: 'Your visa has been issued.',
  REJECTED: 'Your application was not approved. We will contact you about next steps.',
  CANCELLED: 'This application was cancelled.',
};

const blankToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Enter a real date');
const optText = (max: number) => z.preprocess(blankToUndef, z.string().trim().max(max).optional());

export const startVisasSchema = z.object({ bookingId: z.string().uuid() });

export const visaUpdateSchema = z
  .object({
    toStatus: z.enum(VISA_STATUSES),
    note: optText(500),
    applicationNumber: optText(60),
    externalReference: optText(80),
    visaNumber: optText(60),
    validFrom: z.preprocess(blankToUndef, isoDate.optional()),
    validUntil: z.preprocess(blankToUndef, isoDate.optional()),
    rejectionReason: optText(300),
  })
  .superRefine((v, ctx) => {
    if (v.toStatus === 'REJECTED' && !v.rejectionReason) ctx.addIssue({ code: 'custom', path: ['rejectionReason'], message: 'Say why it was rejected' });
    if (v.toStatus === 'ISSUED') {
      if (!v.visaNumber) ctx.addIssue({ code: 'custom', path: ['visaNumber'], message: 'Enter the visa number' });
      if (!v.validFrom) ctx.addIssue({ code: 'custom', path: ['validFrom'], message: 'Enter the first valid day' });
      if (!v.validUntil) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'Enter the last valid day' });
    }
    if (v.validFrom && v.validUntil && v.validUntil <= v.validFrom) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'Must be after the first valid day' });
  });
export type VisaUpdateInput = z.infer<typeof visaUpdateSchema>;

export const visaAssignSchema = z.object({ assignedOfficerId: z.string().uuid().nullable() });

export const adminVisaQuery = z.object({
  status: z.preprocess(blankToUndef, z.enum(VISA_STATUSES).optional()),
  q: z.preprocess(blankToUndef, z.string().trim().max(100).optional()),
  assignedOfficerId: z.preprocess(blankToUndef, z.union([z.literal('none'), z.string().uuid()]).optional()),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface VisaDto {
  id: string;
  bookingId: string;
  bookingReference: string;
  travelerId: string;
  travelerName: string;
  customerName: string;
  departureDate: string;
  status: VisaStatusKey;
  message: string;
  applicationNumber: string | null;
  externalReference: string | null;
  visaNumber: string | null;
  validFrom: string | null;
  validUntil: string | null;
  rejectionReason: string | null;
  submittedAt: string | null;
  issuedAt: string | null;
  assignedOfficerId: string | null;
  assignedOfficerName: string | null;
  notes: string | null;
  history: { status: VisaStatusKey; at: string; note: string | null }[];
  allowedTransitions: VisaStatusKey[];
  /** Required documents that are not yet approved. Empty when the traveler is ready. */
  missingDocuments: string[];
}
