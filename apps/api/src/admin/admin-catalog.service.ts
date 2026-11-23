import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { fromMinor, toMinor, type AdminDepartureDto, type AdminPackageDetailDto, type AdminPackageRowDto, type DepartureInput, type Occupancy, type Paginated, type PackageInput } from '@umrah/shared';

const money = (v: { toString(): string } | null): string | null => (v === null ? null : fromMinor(toMinor(v.toString())));
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { ClientContext } from '../common/http/request-context';
import type { Prisma } from '../generated/prisma/client';
import { utcToday } from '../modules/catalog/catalog.mappers';
import { refreshStartingPrice } from '../modules/catalog/starting-price';
import { asDate, ymd } from '../modules/portal/portal.util';
import { PrismaService } from '../prisma/prisma.service';

const departureInclude = { prices: true, _count: { select: { bookings: { where: { deletedAt: null, status: { not: 'CANCELLED' } } } } } } satisfies Prisma.PackageDepartureInclude;
type DepartureRow = Prisma.PackageDepartureGetPayload<{ include: typeof departureInclude }>;

@Injectable()
export class AdminCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------- packages ------------------------------- */

  async list(q: { q?: string; status?: string; page: number; pageSize: number }): Promise<Paginated<AdminPackageRowDto>> {
    const today = utcToday();
    const where: Prisma.PackageWhereInput = {
      deletedAt: null,
      ...(q.status ? { status: q.status as 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { slug: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const total = await this.prisma.package.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pageCount);
    const rows = await this.prisma.package.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      skip: (page - 1) * q.pageSize,
      take: q.pageSize,
      include: { departures: { where: { status: 'OPEN', departureDate: { gte: today } }, select: { id: true } } },
    });
    return {
      items: rows.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        tier: p.tier,
        status: p.status,
        durationDays: p.durationDays,
        startingPrice: money(p.startingPrice),
        currency: p.currency,
        openDepartures: p.departures.length,
        isFeatured: p.isFeatured,
        updatedAt: p.updatedAt.toISOString(),
      })),
      meta: { total, page, pageSize: q.pageSize, pageCount },
    };
  }

  async get(id: string): Promise<AdminPackageDetailDto> {
    const p = await this.prisma.package.findFirst({
      where: { id, deletedAt: null },
      include: { departures: { orderBy: { departureDate: 'asc' }, include: departureInclude } },
    });
    if (!p) throw new NotFoundException({ message: 'Package not found.', code: 'not_found' });
    const today = utcToday();
    const publishBlockers = this.blockers(p.departures, today);
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      tier: p.tier,
      status: p.status,
      durationDays: p.durationDays,
      startingPrice: money(p.startingPrice),
      currency: p.currency,
      isFeatured: p.isFeatured,
      updatedAt: p.updatedAt.toISOString(),
      subtitle: p.subtitle,
      summary: p.summary,
      description: p.description,
      nightsMakkah: p.nightsMakkah,
      nightsMadinah: p.nightsMadinah,
      departureCities: p.departureCities,
      mealPlan: p.mealPlan,
      inclusions: p.inclusions,
      exclusions: p.exclusions,
      terms: p.terms,
      visaIncluded: p.visaIncluded,
      flightIncluded: p.flightIncluded,
      transportIncluded: p.transportIncluded,
      ziyaratIncluded: p.ziyaratIncluded,
      depositType: p.depositType,
      depositValue: money(p.depositValue) as string,
      seoTitle: p.seoTitle,
      seoDescription: p.seoDescription,
      departures: p.departures.map((d) => this.departureDto(d)),
      publishBlockers,
    };
  }

  async create(user: AuthUser, input: PackageInput, ctx: ClientContext): Promise<AdminPackageDetailDto> {
    await this.assertSlugFree(input.slug);
    const created = await this.prisma.$transaction(async (tx) => {
      const p = await tx.package.create({ data: { ...this.columns(input), status: 'DRAFT' } });
      await this.audit.record({ action: 'package.created', entityType: 'Package', entityId: p.id, actorUserId: user.id, after: { title: input.title, slug: input.slug }, ...ctx }, tx);
      return p;
    });
    return this.get(created.id);
  }

  async update(user: AuthUser, id: string, input: PackageInput, ctx: ClientContext): Promise<AdminPackageDetailDto> {
    const current = await this.prisma.package.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ message: 'Package not found.', code: 'not_found' });
    if (input.slug !== current.slug) {
      // The slug is the public URL and appears in bookings' snapshots and search results: lock it once live.
      if (current.status !== 'DRAFT') throw new ConflictException({ message: 'The web address can only be changed while the package is a draft.', code: 'slug_locked' });
      await this.assertSlugFree(input.slug, id);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.package.update({ where: { id }, data: this.columns(input) });
      await this.audit.record({ action: 'package.updated', entityType: 'Package', entityId: id, actorUserId: user.id, before: { title: current.title, slug: current.slug, depositType: current.depositType, depositValue: current.depositValue.toString() }, after: { title: input.title, slug: input.slug, depositType: input.depositType, depositValue: input.depositValue }, ...ctx }, tx);
    });
    return this.get(id);
  }

  async setStatus(user: AuthUser, id: string, status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED', ctx: ClientContext): Promise<AdminPackageDetailDto> {
    const p = await this.prisma.package.findFirst({ where: { id, deletedAt: null }, include: { departures: { include: departureInclude } } });
    if (!p) throw new NotFoundException({ message: 'Package not found.', code: 'not_found' });
    if (p.status === status) return this.get(id);
    if (status === 'PUBLISHED') {
      const blockers = this.blockers(p.departures, utcToday());
      if (blockers.length > 0) throw new UnprocessableEntityException({ message: `Cannot publish yet: ${blockers.join(' ')}`, code: 'publish_blocked', errors: blockers });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.package.update({ where: { id }, data: { status, ...(status === 'PUBLISHED' && !p.publishedAt ? { publishedAt: new Date() } : {}) } });
      await this.audit.record({ action: `package.${status.toLowerCase()}`, entityType: 'Package', entityId: id, actorUserId: user.id, before: { status: p.status }, after: { status }, ...ctx }, tx);
    });
    return this.get(id);
  }

  /* ------------------------------ departures ------------------------------ */

  async createDeparture(user: AuthUser, packageId: string, input: DepartureInput, ctx: ClientContext): Promise<AdminPackageDetailDto> {
    const pkg = await this.prisma.package.findFirst({ where: { id: packageId, deletedAt: null }, select: { id: true } });
    if (!pkg) throw new NotFoundException({ message: 'Package not found.', code: 'not_found' });
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.packageDeparture.create({
        data: { packageId, ...this.departureColumns(input), prices: { create: input.prices.map((p) => this.priceRow(p)) } },
      });
      await refreshStartingPrice(tx, packageId);
      await this.audit.record({ action: 'departure.created', entityType: 'PackageDeparture', entityId: d.id, actorUserId: user.id, after: { packageId, departureDate: input.departureDate, seatsTotal: input.seatsTotal, prices: input.prices }, ...ctx }, tx);
    });
    return this.get(packageId);
  }

  async updateDeparture(user: AuthUser, packageId: string, departureId: string, input: DepartureInput, ctx: ClientContext): Promise<AdminPackageDetailDto> {
    const current = await this.prisma.packageDeparture.findFirst({ where: { id: departureId, packageId }, include: { prices: true } });
    if (!current) throw new NotFoundException({ message: 'Departure not found.', code: 'not_found' });
    if (input.seatsTotal < current.seatsReserved) {
      throw new UnprocessableEntityException({ message: `${current.seatsReserved} seat(s) are already booked, so the total cannot be lower than that.`, code: 'seats_below_reserved' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.packageDeparture.update({ where: { id: departureId }, data: this.departureColumns(input) });
      // Existing bookings keep the prices they were made with (pricingSnapshot); only new bookings see these.
      await tx.departurePrice.deleteMany({ where: { departureId } });
      if (input.prices.length > 0) await tx.departurePrice.createMany({ data: input.prices.map((p) => ({ departureId, ...this.priceRow(p) })) });
      await refreshStartingPrice(tx, packageId);
      await this.audit.record({ action: 'departure.updated', entityType: 'PackageDeparture', entityId: departureId, actorUserId: user.id, before: { status: current.status, seatsTotal: current.seatsTotal, prices: current.prices.map((p) => ({ occupancy: p.occupancy, adultPrice: p.adultPrice.toString() })) }, after: { status: input.status, seatsTotal: input.seatsTotal, prices: input.prices }, ...ctx }, tx);
    });
    return this.get(packageId);
  }

  async deleteDeparture(user: AuthUser, packageId: string, departureId: string, ctx: ClientContext): Promise<AdminPackageDetailDto> {
    const current = await this.prisma.packageDeparture.findFirst({ where: { id: departureId, packageId }, select: { id: true } });
    if (!current) throw new NotFoundException({ message: 'Departure not found.', code: 'not_found' });
    const bookings = await this.prisma.booking.count({ where: { departureId } });
    if (bookings > 0) {
      throw new ConflictException({ message: 'This departure has bookings, so it cannot be deleted. Set its status to Cancelled or Closed instead.', code: 'departure_has_bookings' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.packageDeparture.delete({ where: { id: departureId } });
      await refreshStartingPrice(tx, packageId);
      await this.audit.record({ action: 'departure.deleted', entityType: 'PackageDeparture', entityId: departureId, actorUserId: user.id, metadata: { packageId }, ...ctx }, tx);
    });
    return this.get(packageId);
  }

  /* ------------------------------ internals ------------------------------ */

  /** A package needs at least one upcoming, open departure with a price before it can go live. */
  private blockers(departures: DepartureRow[], today: Date): string[] {
    const sellable = departures.filter((d) => d.status === 'OPEN' && d.departureDate >= today && d.prices.length > 0);
    return sellable.length === 0 ? ['Add an upcoming departure that is Open and has at least one room price.'] : [];
  }

  private async assertSlugFree(slug: string, exceptId?: string) {
    const clash = await this.prisma.package.findFirst({ where: { slug, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (clash) throw new ConflictException({ message: 'Another package already uses that web address.', code: 'slug_taken', errors: [{ field: 'slug', message: 'Already in use' }] });
  }

  private columns(i: PackageInput) {
    return {
      title: i.title,
      slug: i.slug,
      subtitle: i.subtitle ?? null,
      summary: i.summary ?? null,
      description: i.description ?? null,
      tier: i.tier,
      durationDays: i.durationDays,
      nightsMakkah: i.nightsMakkah,
      nightsMadinah: i.nightsMadinah,
      departureCities: i.departureCities,
      mealPlan: i.mealPlan,
      inclusions: i.inclusions,
      exclusions: i.exclusions,
      terms: i.terms ?? null,
      visaIncluded: i.visaIncluded,
      flightIncluded: i.flightIncluded,
      transportIncluded: i.transportIncluded,
      ziyaratIncluded: i.ziyaratIncluded,
      depositType: i.depositType,
      depositValue: i.depositValue,
      isFeatured: i.isFeatured,
      seoTitle: i.seoTitle ?? null,
      seoDescription: i.seoDescription ?? null,
    };
  }

  private departureColumns(i: DepartureInput) {
    return {
      departureDate: asDate(i.departureDate) as Date,
      returnDate: asDate(i.returnDate) as Date,
      departureCity: i.departureCity ?? null,
      airline: i.airline ?? null,
      flightDetails: i.flightDetails ?? null,
      seatsTotal: i.seatsTotal,
      bookingCutoffDate: asDate(i.bookingCutoffDate),
      status: i.status,
      notes: i.notes ?? null,
    };
  }

  private priceRow(p: DepartureInput['prices'][number]) {
    return { occupancy: p.occupancy, adultPrice: p.adultPrice, childPrice: p.childPrice ?? null, infantPrice: p.infantPrice ?? null };
  }

  private departureDto(d: DepartureRow): AdminDepartureDto {
    return {
      id: d.id,
      departureDate: ymd(d.departureDate) as string,
      returnDate: ymd(d.returnDate) as string,
      departureCity: d.departureCity,
      airline: d.airline,
      flightDetails: d.flightDetails,
      seatsTotal: d.seatsTotal,
      seatsReserved: d.seatsReserved,
      bookingCutoffDate: ymd(d.bookingCutoffDate),
      status: d.status,
      notes: d.notes,
      bookings: d._count.bookings,
      prices: d.prices.map((p) => ({ occupancy: p.occupancy as Occupancy, adultPrice: money(p.adultPrice) as string, childPrice: money(p.childPrice), infantPrice: money(p.infantPrice) })),
    };
  }
}
