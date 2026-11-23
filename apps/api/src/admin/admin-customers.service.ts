import { Injectable, NotFoundException } from '@nestjs/common';
import type { AdminCustomerDetailDto, AdminCustomerRowDto, NoteDto, Paginated } from '@umrah/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { FieldEncryption } from '../common/crypto/field-encryption';
import type { ClientContext } from '../common/http/request-context';
import type { Prisma } from '../generated/prisma/client';
import { BookingsService, detailInclude } from '../modules/portal/bookings.service';
import { travelerToDto } from '../modules/portal/portal.util';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly enc: FieldEncryption,
    private readonly audit: AuditService,
  ) {}

  async list(q: { q?: string; page: number; pageSize: number }): Promise<Paginated<AdminCustomerRowDto>> {
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : null;
    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      ...(contains ? { OR: [{ firstName: contains }, { lastName: contains }, { email: contains }, { phone: contains }, { city: contains }] } : {}),
    };
    const total = await this.prisma.customer.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pageCount);
    const rows = await this.prisma.customer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * q.pageSize,
      take: q.pageSize,
      include: { _count: { select: { bookings: { where: { deletedAt: null } } } } },
    });
    return {
      items: rows.map((c) => ({
        id: c.id,
        name: `${c.firstName} ${c.lastName}`,
        email: c.email,
        phone: c.phone,
        city: c.city,
        hasAccount: c.userId !== null,
        bookings: c._count.bookings,
        createdAt: c.createdAt.toISOString(),
      })),
      meta: { total, page, pageSize: q.pageSize, pageCount },
    };
  }

  async get(id: string): Promise<AdminCustomerDetailDto> {
    const c = await this.prisma.customer.findFirst({
      where: { id, deletedAt: null },
      include: {
        travelers: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
        bookings: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 50, include: detailInclude },
        notes: { orderBy: { createdAt: 'desc' }, take: 50, include: { author: { select: { firstName: true, lastName: true } } } },
      },
    });
    if (!c) throw new NotFoundException({ message: 'Customer not found.', code: 'not_found' });
    const notes: NoteDto[] = c.notes.map((n) => ({ id: n.id, body: n.body, authorName: n.author ? `${n.author.firstName} ${n.author.lastName}` : null, createdAt: n.createdAt.toISOString() }));
    return {
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      whatsappNumber: c.whatsappNumber,
      whatsappOptIn: c.whatsappOptInAt !== null,
      marketingOptIn: c.marketingOptIn,
      country: c.country,
      city: c.city,
      addressLine: c.addressLine,
      preferredLanguage: c.preferredLanguage,
      hasAccount: c.userId !== null,
      createdAt: c.createdAt.toISOString(),
      travelers: c.travelers.map((t) => travelerToDto(t, this.enc)),
      bookings: c.bookings.map((b) => this.bookings.summary(b)),
      notes,
    };
  }

  async addNote(user: AuthUser, id: string, body: string, ctx: ClientContext): Promise<AdminCustomerDetailDto> {
    const exists = await this.prisma.customer.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!exists) throw new NotFoundException({ message: 'Customer not found.', code: 'not_found' });
    await this.prisma.$transaction(async (tx) => {
      const note = await tx.crmNote.create({ data: { customerId: id, authorId: user.id, body } });
      await this.audit.record({ action: 'customer.note_added', entityType: 'Customer', entityId: id, actorUserId: user.id, metadata: { noteId: note.id }, ...ctx }, tx);
    });
    return this.get(id);
  }
}
