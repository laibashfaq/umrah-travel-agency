import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { TravelerDto, TravelerInput } from '@umrah/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import type { ClientContext } from '../../common/http/request-context';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { asDate, requireCustomerId, travelerToDto } from './portal.util';

const MAX_SAVED_TRAVELERS = 50;
/** Submitted bookings hold a copy of who is travelling; their details are corrected by staff, not edited in place. */
const LOCKED_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'VISA_PROCESSING', 'TRAVEL_PREPARATION'] as const;

type StoredIdentity = { passportNumberEnc: string | null; passportNumberHash: string | null; nationalIdEnc: string | null; nationalIdHash: string | null };

@Injectable()
export class TravelersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: FieldEncryption,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser): Promise<TravelerDto[]> {
    const rows = await this.prisma.traveler.findMany({ where: { customerId: requireCustomerId(user), deletedAt: null }, orderBy: [{ createdAt: 'asc' }] });
    return rows.map((r) => travelerToDto(r, this.enc));
  }

  async get(user: AuthUser, id: string): Promise<TravelerDto> {
    return travelerToDto(await this.owned(user, id), this.enc);
  }

  async create(user: AuthUser, input: TravelerInput, ctx: ClientContext): Promise<TravelerDto> {
    const customerId = requireCustomerId(user);
    if ((await this.prisma.traveler.count({ where: { customerId, deletedAt: null } })) >= MAX_SAVED_TRAVELERS) {
      throw new ConflictException({ message: `You can save up to ${MAX_SAVED_TRAVELERS} travelers.`, code: 'traveler_limit' });
    }
    await this.assertNoDuplicate(customerId, input);
    await this.assertMahram(customerId, input.mahramTravelerId, null);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.traveler.create({ data: { customerId, ...this.columns(input) } });
      await this.audit.record({ action: 'traveler.created', entityType: 'Traveler', entityId: created.id, actorUserId: user.id, after: { ...input }, ...ctx }, tx);
      return created;
    });
    return travelerToDto(row, this.enc);
  }

  async update(user: AuthUser, id: string, input: TravelerInput, ctx: ClientContext): Promise<TravelerDto> {
    const current = await this.owned(user, id);
    await this.assertNotLocked(id);
    await this.assertNoDuplicate(current.customerId, input, id);
    await this.assertMahram(current.customerId, input.mahramTravelerId, id);
    const row = await this.prisma.$transaction(async (tx) => {
      // Leaving the passport/ID field empty keeps the stored value; a new value replaces it.
      const updated = await tx.traveler.update({ where: { id }, data: this.columns(input, current) });
      await this.audit.record({ action: 'traveler.updated', entityType: 'Traveler', entityId: id, actorUserId: user.id, after: { ...input }, ...ctx }, tx);
      return updated;
    });
    return travelerToDto(row, this.enc);
  }

  async remove(user: AuthUser, id: string, ctx: ClientContext): Promise<void> {
    await this.owned(user, id);
    const inUse = await this.prisma.bookingTraveler.count({ where: { travelerId: id, booking: { deletedAt: null, status: { not: 'CANCELLED' } } } });
    if (inUse > 0) {
      throw new ConflictException({ message: 'This traveler is on a booking, so it cannot be removed. Contact us if the details need correcting.', code: 'traveler_in_use' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.traveler.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.record({ action: 'traveler.deleted', entityType: 'Traveler', entityId: id, actorUserId: user.id, ...ctx }, tx);
    });
  }

  private async owned(user: AuthUser, id: string) {
    const row = await this.prisma.traveler.findFirst({ where: { id, customerId: requireCustomerId(user), deletedAt: null } });
    if (!row) throw new NotFoundException({ message: 'Traveler not found.', code: 'not_found' });
    return row;
  }

  private async assertNotLocked(travelerId: string) {
    const locked = await this.prisma.bookingTraveler.count({ where: { travelerId, booking: { deletedAt: null, status: { in: [...LOCKED_STATUSES] } } } });
    if (locked > 0) {
      throw new ConflictException({ message: 'This traveler is on a submitted booking. Contact us to correct their details.', code: 'traveler_locked' });
    }
  }

  private async assertNoDuplicate(customerId: string, input: TravelerInput, exceptId?: string) {
    const checks: Prisma.TravelerWhereInput[] = [];
    if (input.passportNumber) checks.push({ passportNumberHash: this.enc.hash(input.passportNumber) });
    if (input.nationalId) checks.push({ nationalIdHash: this.enc.hash(input.nationalId) });
    if (checks.length === 0) return;
    const dup = await this.prisma.traveler.findFirst({ where: { customerId, deletedAt: null, OR: checks, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (dup) throw new ConflictException({ message: 'A traveler with this passport or ID number is already saved.', code: 'traveler_duplicate' });
  }

  private async assertMahram(customerId: string, mahramId: string | undefined, selfId: string | null) {
    if (!mahramId) return;
    if (mahramId === selfId) throw new UnprocessableEntityException({ message: 'A traveler cannot be their own mahram.', code: 'invalid_mahram' });
    const m = await this.prisma.traveler.findFirst({ where: { id: mahramId, customerId, deletedAt: null }, select: { id: true } });
    if (!m) throw new UnprocessableEntityException({ message: 'Choose a mahram from your saved travelers.', code: 'invalid_mahram' });
  }

  private columns(input: TravelerInput, existing?: StoredIdentity) {
    return {
      relationship: input.relationship,
      title: input.title ?? null,
      firstName: input.firstName,
      middleName: input.middleName ?? null,
      lastName: input.lastName,
      fatherOrHusbandName: input.fatherOrHusbandName ?? null,
      gender: input.gender,
      dateOfBirth: asDate(input.dateOfBirth) as Date,
      placeOfBirth: input.placeOfBirth ?? null,
      nationality: input.nationality,
      passportNumberEnc: input.passportNumber ? this.enc.encrypt(input.passportNumber) : (existing?.passportNumberEnc ?? null),
      passportNumberHash: input.passportNumber ? this.enc.hash(input.passportNumber) : (existing?.passportNumberHash ?? null),
      passportIssuingCountry: input.passportIssuingCountry ?? null,
      passportIssueDate: asDate(input.passportIssueDate),
      passportExpiryDate: asDate(input.passportExpiryDate),
      nationalIdEnc: input.nationalId ? this.enc.encrypt(input.nationalId) : (existing?.nationalIdEnc ?? null),
      nationalIdHash: input.nationalId ? this.enc.hash(input.nationalId) : (existing?.nationalIdHash ?? null),
      phone: input.phone ?? null,
      email: input.email ?? null,
      mahramTravelerId: input.mahramTravelerId ?? null,
      mahramRelationship: input.mahramRelationship ?? null,
      specialRequirements: input.specialRequirements ?? null,
    };
  }
}
