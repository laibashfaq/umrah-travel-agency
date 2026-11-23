import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import {
  MAX_DOCUMENT_BYTES,
  STAFF_DOCUMENT_TYPES,
  type DocumentDto,
  type DocumentReviewInput,
  type Paginated,
  type UploadQuery,
} from '@umrah/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { ClientContext } from '../common/http/request-context';
import type { Prisma } from '../generated/prisma/client';
import { asDate, fullName, requireCustomerId, ymd } from '../modules/portal/portal.util';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { detectFileType, safeFileName } from './file-type';

/** What an upload needs, whoever makes it: staff may use document types customers cannot. */
type StoreQuery = Omit<UploadQuery, 'type'> & { type: (typeof STAFF_DOCUMENT_TYPES)[number] };

const include = {
  traveler: { select: { firstName: true, middleName: true, lastName: true } },
  customer: { select: { firstName: true, lastName: true } },
  booking: { select: { reference: true } },
  reviewedBy: { select: { firstName: true, lastName: true } },
  uploadedBy: { select: { type: true } },
} satisfies Prisma.DocumentInclude;
type DocumentRow = Prisma.DocumentGetPayload<{ include: typeof include }>;

export interface DownloadedFile {
  body: Buffer;
  mime: string;
  fileName: string;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------- customer ------------------------------- */

  async listMine(user: AuthUser): Promise<DocumentDto[]> {
    const rows = await this.prisma.document.findMany({ where: { customerId: requireCustomerId(user), deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 300, include });
    return rows.map((r) => this.dto(r));
  }

  async uploadMine(user: AuthUser, query: UploadQuery, body: unknown, ctx: ClientContext): Promise<DocumentDto> {
    const customerId = requireCustomerId(user);
    if (query.type === 'PAYMENT_PROOF') {
      throw new BadRequestException({ message: 'Tell us about a payment from the booking page; proof is attached there.', code: 'unsupported_type' });
    }
    if (query.travelerId) {
      const t = await this.prisma.traveler.findFirst({ where: { id: query.travelerId, customerId, deletedAt: null }, select: { id: true } });
      if (!t) throw new NotFoundException({ message: 'Traveler not found.', code: 'not_found' });
    } else if (query.type === 'PASSPORT' || query.type === 'PHOTO') {
      throw new BadRequestException({ message: 'Choose which traveler this belongs to.', code: 'traveler_required', errors: [{ field: 'travelerId', message: 'Required' }] });
    }
    if (query.bookingId) {
      const b = await this.prisma.booking.findFirst({ where: { id: query.bookingId, customerId, deletedAt: null }, select: { id: true } });
      if (!b) throw new NotFoundException({ message: 'Booking not found.', code: 'not_found' });
    }
    return this.store({ customerId, uploadedById: user.id }, query, body, ctx);
  }

  async deleteMine(user: AuthUser, id: string, ctx: ClientContext): Promise<void> {
    const doc = await this.prisma.document.findFirst({ where: { id, customerId: requireCustomerId(user), deletedAt: null } });
    if (!doc) throw new NotFoundException({ message: 'Document not found.', code: 'not_found' });
    if (doc.status === 'APPROVED') throw new ConflictException({ message: 'An approved document cannot be removed. Contact us if it is wrong.', code: 'approved_locked' });
    await this.softDelete(doc.id, doc.storageKey, user.id, ctx);
  }

  async downloadMine(user: AuthUser, id: string, ctx: ClientContext): Promise<DownloadedFile> {
    const doc = await this.prisma.document.findFirst({ where: { id, customerId: requireCustomerId(user), deletedAt: null } });
    if (!doc) throw new NotFoundException({ message: 'Document not found.', code: 'not_found' });
    return this.read(doc, user.id, ctx);
  }

  /* --------------------------------- staff --------------------------------- */

  async list(q: { status?: string; type?: string; q?: string; page: number; pageSize: number }): Promise<Paginated<DocumentDto>> {
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : null;
    const where: Prisma.DocumentWhereInput = {
      deletedAt: null,
      ...(q.status ? { status: q.status as 'PENDING_REVIEW' } : {}),
      ...(q.type ? { type: q.type as 'PASSPORT' } : {}),
      ...(contains ? { OR: [{ traveler: { OR: [{ firstName: contains }, { lastName: contains }] } }, { customer: { OR: [{ firstName: contains }, { lastName: contains }, { email: contains }] } }, { booking: { reference: contains } }] } : {}),
    };
    const total = await this.prisma.document.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pageCount);
    const rows = await this.prisma.document.findMany({ where, orderBy: [{ createdAt: 'asc' }], skip: (page - 1) * q.pageSize, take: q.pageSize, include });
    return { items: rows.map((r) => this.dto(r)), meta: { total, page, pageSize: q.pageSize, pageCount } };
  }

  async forTraveler(travelerId: string): Promise<DocumentDto[]> {
    const rows = await this.prisma.document.findMany({ where: { travelerId, deletedAt: null }, orderBy: { createdAt: 'desc' }, include });
    return rows.map((r) => this.dto(r));
  }

  async uploadForTraveler(user: AuthUser, query: StoreQuery & { travelerId: string; visaApplicationId?: string }, body: unknown, ctx: ClientContext): Promise<DocumentDto> {
    const t = await this.prisma.traveler.findFirst({ where: { id: query.travelerId, deletedAt: null }, select: { customerId: true } });
    if (!t) throw new NotFoundException({ message: 'Traveler not found.', code: 'not_found' });
    return this.store({ customerId: t.customerId, uploadedById: user.id, visaApplicationId: query.visaApplicationId }, query, body, ctx, true);
  }

  async review(user: AuthUser, id: string, input: DocumentReviewInput, ctx: ClientContext): Promise<DocumentDto> {
    await this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.findFirst({ where: { id, deletedAt: null } });
      if (!doc) throw new NotFoundException({ message: 'Document not found.', code: 'not_found' });
      if (doc.status !== 'PENDING_REVIEW') throw new ConflictException({ message: 'This document has already been reviewed.', code: 'already_reviewed' });
      const moved = await tx.document.updateMany({
        where: { id, status: 'PENDING_REVIEW' },
        data: input.decision === 'APPROVE'
          ? { status: 'APPROVED', reviewedById: user.id, reviewedAt: new Date(), rejectionReason: null, expiresAt: asDate(input.expiresAt) }
          : { status: 'REJECTED', reviewedById: user.id, reviewedAt: new Date(), rejectionReason: input.reason },
      });
      if (moved.count !== 1) throw new ConflictException({ message: 'Someone else just reviewed this document.', code: 'conflict' });
      await this.audit.record({ action: input.decision === 'APPROVE' ? 'document.approved' : 'document.rejected', entityType: 'Document', entityId: id, actorUserId: user.id, metadata: { type: doc.type, reason: input.reason }, ...ctx }, tx);
    });
    return this.get(id);
  }

  async downloadStaff(user: AuthUser, id: string, ctx: ClientContext): Promise<DownloadedFile> {
    const doc = await this.prisma.document.findFirst({ where: { id, deletedAt: null } });
    if (!doc) throw new NotFoundException({ message: 'Document not found.', code: 'not_found' });
    return this.read(doc, user.id, ctx);
  }

  async deleteStaff(user: AuthUser, id: string, ctx: ClientContext): Promise<void> {
    const doc = await this.prisma.document.findFirst({ where: { id, deletedAt: null } });
    if (!doc) throw new NotFoundException({ message: 'Document not found.', code: 'not_found' });
    await this.softDelete(doc.id, doc.storageKey, user.id, ctx);
  }

  async get(id: string): Promise<DocumentDto> {
    const row = await this.prisma.document.findFirst({ where: { id, deletedAt: null }, include });
    if (!row) throw new NotFoundException({ message: 'Document not found.', code: 'not_found' });
    return this.dto(row);
  }

  /* ------------------------------- internals ------------------------------- */

  private async store(owner: { customerId: string; uploadedById: string; visaApplicationId?: string }, query: StoreQuery, body: unknown, ctx: ClientContext, byStaff = false): Promise<DocumentDto> {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException({ message: 'Choose a file to upload.', code: 'no_file' });
    }
    if (body.length > MAX_DOCUMENT_BYTES) {
      throw new PayloadTooLargeException({ message: `Files can be up to ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`, code: 'too_large' });
    }
    const kind = detectFileType(body);
    if (!kind) throw new UnsupportedMediaTypeException({ message: 'Upload a PDF, JPEG or PNG file.', code: 'unsupported_file' });

    const key = this.storage.newKey();
    await this.storage.put(key, body, kind.mime);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const doc = await tx.document.create({
          data: {
            type: query.type,
            // Staff uploads are trusted; customer uploads wait for a person to look at them.
            status: byStaff ? 'APPROVED' : 'PENDING_REVIEW',
            ...(byStaff ? { reviewedById: owner.uploadedById, reviewedAt: new Date() } : {}),
            customerId: owner.customerId,
            travelerId: query.travelerId ?? null,
            bookingId: query.bookingId ?? null,
            visaApplicationId: owner.visaApplicationId ?? null,
            storageKey: key,
            originalFileName: safeFileName(query.fileName, kind.extension),
            mimeType: kind.mime,
            sizeBytes: body.length,
            checksumSha256: createHash('sha256').update(body).digest('hex'),
            // No malware scanner is connected yet: say so rather than pretending the file is clean.
            scanStatus: 'PENDING',
            uploadedById: owner.uploadedById,
          },
        });
        await this.audit.record({ action: 'document.uploaded', entityType: 'Document', entityId: doc.id, actorUserId: owner.uploadedById, metadata: { type: query.type, mime: kind.mime, bytes: body.length, byStaff }, ...ctx }, tx);
        return doc;
      });
      return this.get(created.id);
    } catch (e) {
      await this.storage.remove(key).catch(() => undefined); // never leave an orphan file behind a failed save
      throw e;
    }
  }

  private async read(doc: { id: string; storageKey: string; mimeType: string; originalFileName: string; type: string }, actorId: string, ctx: ClientContext): Promise<DownloadedFile> {
    const body = await this.storage.get(doc.storageKey).catch(() => {
      throw new NotFoundException({ message: 'The file is not available.', code: 'file_missing' });
    });
    await this.audit.record({ action: 'document.downloaded', entityType: 'Document', entityId: doc.id, actorUserId: actorId, metadata: { type: doc.type }, ...ctx });
    return { body, mime: doc.mimeType, fileName: doc.originalFileName };
  }

  private async softDelete(id: string, storageKey: string, actorId: string, ctx: ClientContext) {
    await this.prisma.$transaction(async (tx) => {
      await tx.document.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.record({ action: 'document.deleted', entityType: 'Document', entityId: id, actorUserId: actorId, ...ctx }, tx);
    });
    // The record is kept (soft delete) for the audit trail, but the personal file itself is erased.
    await this.storage.remove(storageKey).catch(() => undefined);
  }

  private dto(r: DocumentRow): DocumentDto {
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      travelerId: r.travelerId,
      travelerName: r.traveler ? fullName(r.traveler) : null,
      customerName: r.customer ? `${r.customer.firstName} ${r.customer.lastName}` : null,
      bookingId: r.bookingId,
      bookingReference: r.booking?.reference ?? null,
      fileName: r.originalFileName,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      rejectionReason: r.rejectionReason,
      reviewedByName: r.reviewedBy ? `${r.reviewedBy.firstName} ${r.reviewedBy.lastName}` : null,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      expiresAt: ymd(r.expiresAt),
      uploadedByStaff: r.uploadedBy?.type === 'STAFF',
      createdAt: r.createdAt.toISOString(),
    };
  }
}
