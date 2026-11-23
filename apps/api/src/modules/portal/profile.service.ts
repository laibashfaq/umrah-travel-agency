import { Injectable, NotFoundException } from '@nestjs/common';
import type { ProfileDto, ProfileUpdateInput } from '@umrah/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import type { ClientContext } from '../../common/http/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { requireCustomerId } from './portal.util';

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(user: AuthUser): Promise<ProfileDto> {
    const customerId = requireCustomerId(user);
    const c = await this.prisma.customer.findFirst({ where: { id: customerId, deletedAt: null }, include: { user: { select: { id: true, email: true, phone: true, emailVerifiedAt: true } } } });
    if (!c?.user) throw new NotFoundException('Profile not found');
    return {
      userId: c.user.id,
      customerId: c.id,
      email: c.user.email,
      emailVerified: c.user.emailVerifiedAt !== null,
      firstName: c.firstName,
      lastName: c.lastName,
      phone: c.phone ?? c.user.phone,
      whatsappNumber: c.whatsappNumber,
      whatsappOptIn: c.whatsappOptInAt !== null,
      marketingOptIn: c.marketingOptIn,
      country: c.country,
      city: c.city,
      addressLine: c.addressLine,
      preferredLanguage: c.preferredLanguage,
    };
  }

  async update(user: AuthUser, input: ProfileUpdateInput, ctx: ClientContext): Promise<ProfileDto> {
    const customerId = requireCustomerId(user);
    const before = await this.get(user);
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { whatsappOptInAt: true } });
      await tx.customer.update({
        where: { id: customerId },
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone ?? null,
          whatsappNumber: input.whatsappNumber ?? null,
          whatsappOptInAt: input.whatsappOptIn ? (current.whatsappOptInAt ?? new Date()) : null,
          marketingOptIn: input.marketingOptIn,
          country: input.country ?? null,
          city: input.city ?? null,
          addressLine: input.addressLine ?? null,
          preferredLanguage: input.preferredLanguage,
        },
      });
      await tx.user.update({ where: { id: user.id }, data: { firstName: input.firstName, lastName: input.lastName, phone: input.phone ?? null } });
      await this.audit.record({ action: 'customer.profile_updated', entityType: 'Customer', entityId: customerId, actorUserId: user.id, before, after: input, ...ctx }, tx);
    });
    return this.get(user);
  }
}
