import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  canTransitionVisa,
  DOCUMENT_LABEL,
  REQUIRED_TRAVELER_DOCUMENTS,
  VISA_CUSTOMER_MESSAGE,
  VISA_TRANSITIONS,
  type Paginated,
  type VisaDto,
  type VisaStatusKey,
  type VisaUpdateInput,
} from '@umrah/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { ClientContext } from '../common/http/request-context';
import type { Prisma } from '../generated/prisma/client';
import { asDate, fullName, requireCustomerId, ymd } from '../modules/portal/portal.util';
import { PrismaService } from '../prisma/prisma.service';

const include = {
  booking: { select: { reference: true, customerId: true, departure: { select: { departureDate: true } }, customer: { select: { firstName: true, lastName: true } } } },
  traveler: { select: { id: true, firstName: true, middleName: true, lastName: true } },
  assignedOfficer: { select: { firstName: true, lastName: true } },
  statusHistory: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.VisaApplicationInclude;
type VisaRow = Prisma.VisaApplicationGetPayload<{ include: typeof include }>;

/** Bookings whose travelers can be put through the visa process. */
const VISA_BOOKING = ['CONFIRMED', 'VISA_PROCESSING', 'TRAVEL_PREPARATION'] as const;

@Injectable()
export class VisaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------- customer ------------------------------- */

  async listMine(user: AuthUser): Promise<VisaDto[]> {
    const rows = await this.prisma.visaApplication.findMany({ where: { booking: { customerId: requireCustomerId(user), deletedAt: null } }, orderBy: { createdAt: 'desc' }, include });
    return Promise.all(rows.map((r) => this.dto(r, false)));
  }

  /* --------------------------------- staff --------------------------------- */

  async list(q: { status?: string; q?: string; assignedOfficerId?: string; page: number; pageSize: number }): Promise<Paginated<VisaDto>> {
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : null;
    const where: Prisma.VisaApplicationWhereInput = {
      ...(q.status ? { status: q.status as 'NOT_STARTED' } : {}),
      ...(q.assignedOfficerId ? (q.assignedOfficerId === 'none' ? { assignedOfficerId: null } : { assignedOfficerId: q.assignedOfficerId }) : {}),
      ...(contains ? { OR: [{ booking: { reference: contains } }, { traveler: { OR: [{ firstName: contains }, { lastName: contains }] } }, { applicationNumber: contains }] } : {}),
    };
    const total = await this.prisma.visaApplication.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pageCount);
    const rows = await this.prisma.visaApplication.findMany({ where, orderBy: [{ updatedAt: 'desc' }], skip: (page - 1) * q.pageSize, take: q.pageSize, include });
    return { items: await Promise.all(rows.map((r) => this.dto(r, true))), meta: { total, page, pageSize: q.pageSize, pageCount } };
  }

  async forBooking(bookingId: string): Promise<VisaDto[]> {
    const rows = await this.prisma.visaApplication.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' }, include });
    return Promise.all(rows.map((r) => this.dto(r, true)));
  }

  async get(id: string): Promise<VisaDto> {
    const row = await this.prisma.visaApplication.findUnique({ where: { id }, include });
    if (!row) throw new NotFoundException({ message: 'Visa application not found.', code: 'not_found' });
    return this.dto(row, true);
  }

  /** Opens an application for every traveler on a confirmed booking who does not have one yet. */
  async startForBooking(user: AuthUser, bookingId: string, ctx: ClientContext): Promise<VisaDto[]> {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, deletedAt: null }, include: { travelers: { select: { travelerId: true } } } });
    if (!booking) throw new NotFoundException({ message: 'Booking not found.', code: 'not_found' });
    if (!(VISA_BOOKING as readonly string[]).includes(booking.status)) {
      throw new ConflictException({ message: 'Visa applications start once the booking is confirmed.', code: 'booking_not_confirmed' });
    }
    await this.prisma.$transaction(async (tx) => {
      const existing = new Set((await tx.visaApplication.findMany({ where: { bookingId }, select: { travelerId: true } })).map((v) => v.travelerId));
      let created = 0;
      for (const { travelerId } of booking.travelers) {
        if (existing.has(travelerId)) continue;
        const app = await tx.visaApplication.create({ data: { bookingId, travelerId, status: 'DOCUMENTS_PENDING', assignedOfficerId: null } });
        await tx.visaStatusHistory.create({ data: { visaApplicationId: app.id, fromStatus: null, toStatus: 'DOCUMENTS_PENDING', changedById: user.id, note: 'Application opened' } });
        created += 1;
      }
      if (created > 0) await this.audit.record({ action: 'visa.started', entityType: 'Booking', entityId: bookingId, actorUserId: user.id, metadata: { applications: created }, ...ctx }, tx);
    });
    return this.forBooking(bookingId);
  }

  async changeStatus(user: AuthUser, id: string, input: VisaUpdateInput, ctx: ClientContext): Promise<VisaDto> {
    const current = await this.prisma.visaApplication.findUnique({ where: { id }, include });
    if (!current) throw new NotFoundException({ message: 'Visa application not found.', code: 'not_found' });
    const from = current.status as VisaStatusKey;
    const to = input.toStatus;
    if (from === to) throw new ConflictException({ message: 'The application is already in that status.', code: 'no_change' });
    if (!canTransitionVisa(from, to)) throw new UnprocessableEntityException({ message: `An application cannot move from ${from} to ${to}.`, code: 'invalid_transition' });

    const docs = await this.requiredDocs(current.travelerId);
    if (to === 'UNDER_REVIEW' && docs.uploaded.length < REQUIRED_TRAVELER_DOCUMENTS.length) {
      throw new UnprocessableEntityException({ message: `Waiting for ${docs.notUploaded.map((t) => DOCUMENT_LABEL[t]).join(' and ')} from the customer.`, code: 'documents_missing' });
    }
    if (to === 'READY_TO_SUBMIT' && docs.notApproved.length > 0) {
      throw new UnprocessableEntityException({ message: `Approve ${docs.notApproved.map((t) => DOCUMENT_LABEL[t]).join(' and ')} first.`, code: 'documents_not_approved' });
    }

    const now = new Date();
    const data: Prisma.VisaApplicationUpdateManyMutationInput = {
      status: to,
      ...(input.applicationNumber ? { applicationNumber: input.applicationNumber } : {}),
      ...(input.externalReference ? { externalReference: input.externalReference } : {}),
      ...(to === 'SUBMITTED' ? { submittedAt: now } : {}),
      ...(to === 'APPROVED' || to === 'REJECTED' ? { decidedAt: now } : {}),
      ...(to === 'REJECTED' ? { rejectionReason: input.rejectionReason } : {}),
      ...(to === 'DOCUMENTS_PENDING' ? { rejectionReason: null } : {}),
      ...(to === 'ISSUED' ? { issuedAt: now, visaNumber: input.visaNumber, validFrom: asDate(input.validFrom), validUntil: asDate(input.validUntil) } : {}),
    };
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.visaApplication.updateMany({ where: { id, status: from }, data });
      if (moved.count !== 1) throw new ConflictException({ message: 'Someone else just changed this application. Refresh and try again.', code: 'conflict' });
      await tx.visaStatusHistory.create({ data: { visaApplicationId: id, fromStatus: from, toStatus: to, changedById: user.id, note: input.note ?? input.rejectionReason ?? null } });
      await this.audit.record({ action: 'visa.status_changed', entityType: 'VisaApplication', entityId: id, actorUserId: user.id, before: { status: from }, after: { status: to }, metadata: { note: input.note, bookingId: current.bookingId }, ...ctx }, tx);
    });
    return this.get(id);
  }

  async assign(user: AuthUser, id: string, officerId: string | null, ctx: ClientContext): Promise<VisaDto> {
    const current = await this.prisma.visaApplication.findUnique({ where: { id }, select: { assignedOfficerId: true } });
    if (!current) throw new NotFoundException({ message: 'Visa application not found.', code: 'not_found' });
    if (officerId) {
      const ok = await this.prisma.user.findFirst({ where: { id: officerId, type: 'STAFF', status: 'ACTIVE', deletedAt: null, roles: { some: { role: { permissions: { some: { permission: { key: 'visas:update' } } } } } } }, select: { id: true } });
      if (!ok) throw new UnprocessableEntityException({ message: 'Choose an active staff member who can work on visas.', code: 'invalid_assignee' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.visaApplication.update({ where: { id }, data: { assignedOfficerId: officerId } });
      await this.audit.record({ action: 'visa.assigned', entityType: 'VisaApplication', entityId: id, actorUserId: user.id, before: { assignedOfficerId: current.assignedOfficerId }, after: { assignedOfficerId: officerId }, ...ctx }, tx);
    });
    return this.get(id);
  }

  async officers(): Promise<{ id: string; name: string }[]> {
    const rows = await this.prisma.user.findMany({
      where: { type: 'STAFF', status: 'ACTIVE', deletedAt: null, roles: { some: { role: { permissions: { some: { permission: { key: 'visas:update' } } } } } } },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: { id: true, firstName: true, lastName: true },
    });
    return rows.map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}` }));
  }

  /* ------------------------------- internals ------------------------------- */

  /** Which of the required documents the traveler has uploaded, and which are approved and still valid. */
  private async requiredDocs(travelerId: string) {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const docs = await this.prisma.document.findMany({
      where: { travelerId, deletedAt: null, type: { in: [...REQUIRED_TRAVELER_DOCUMENTS] }, status: { in: ['PENDING_REVIEW', 'APPROVED'] } },
      select: { type: true, status: true, expiresAt: true },
    });
    const uploaded = REQUIRED_TRAVELER_DOCUMENTS.filter((t) => docs.some((d) => d.type === t));
    const approved = REQUIRED_TRAVELER_DOCUMENTS.filter((t) => docs.some((d) => d.type === t && d.status === 'APPROVED' && (!d.expiresAt || d.expiresAt >= today)));
    return {
      uploaded,
      notUploaded: REQUIRED_TRAVELER_DOCUMENTS.filter((t) => !uploaded.includes(t)),
      notApproved: REQUIRED_TRAVELER_DOCUMENTS.filter((t) => !approved.includes(t)),
    };
  }

  private async dto(r: VisaRow, staff: boolean): Promise<VisaDto> {
    const status = r.status as VisaStatusKey;
    const docs = await this.requiredDocs(r.travelerId);
    return {
      id: r.id,
      bookingId: r.bookingId,
      bookingReference: r.booking.reference,
      travelerId: r.travelerId,
      travelerName: fullName(r.traveler),
      customerName: `${r.booking.customer.firstName} ${r.booking.customer.lastName}`,
      departureDate: ymd(r.booking.departure.departureDate) as string,
      status,
      message: VISA_CUSTOMER_MESSAGE[status],
      applicationNumber: staff ? r.applicationNumber : null,
      externalReference: staff ? r.externalReference : null,
      // Customers only see the visa details once it has been issued.
      visaNumber: staff || status === 'ISSUED' ? r.visaNumber : null,
      validFrom: staff || status === 'ISSUED' ? ymd(r.validFrom) : null,
      validUntil: staff || status === 'ISSUED' ? ymd(r.validUntil) : null,
      rejectionReason: r.rejectionReason,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      issuedAt: r.issuedAt?.toISOString() ?? null,
      assignedOfficerId: staff ? r.assignedOfficerId : null,
      assignedOfficerName: staff && r.assignedOfficer ? `${r.assignedOfficer.firstName} ${r.assignedOfficer.lastName}` : null,
      notes: staff ? r.notes : null,
      history: r.statusHistory.map((h) => ({ status: h.toStatus as VisaStatusKey, at: h.createdAt.toISOString(), note: staff ? h.note : null })),
      allowedTransitions: staff ? [...VISA_TRANSITIONS[status]] : [],
      missingDocuments: docs.notApproved.map((t) => DOCUMENT_LABEL[t] ?? t),
    };
  }
}
