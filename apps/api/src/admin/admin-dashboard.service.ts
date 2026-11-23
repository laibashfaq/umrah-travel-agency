import { Injectable } from '@nestjs/common';
import { fromMinor, toMinor, type BookingStatusKey, type DashboardStatsDto } from '@umrah/shared';
import { BookingsService, detailInclude } from '../modules/portal/bookings.service';
import { utcToday } from '../modules/catalog/catalog.mappers';
import { PrismaService } from '../prisma/prisma.service';

const DAY = 86_400_000;

@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
  ) {}

  async stats(): Promise<DashboardStatsDto> {
    const now = new Date();
    const today = utcToday(now);
    const live = { deletedAt: null } as const;
    const [byStatus, last7, customers, newCustomers, published, openDepartures, seats, leaving, value, recent] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['status'], where: live, _count: { _all: true } }),
      this.prisma.booking.count({ where: { ...live, status: { not: 'DRAFT' }, createdAt: { gte: new Date(now.getTime() - 7 * DAY) } } }),
      this.prisma.customer.count({ where: live }),
      this.prisma.customer.count({ where: { ...live, createdAt: { gte: new Date(now.getTime() - 30 * DAY) } } }),
      this.prisma.package.count({ where: { ...live, status: 'PUBLISHED' } }),
      this.prisma.packageDeparture.count({ where: { status: 'OPEN', departureDate: { gte: today }, package: { status: 'PUBLISHED', deletedAt: null } } }),
      this.prisma.packageDeparture.aggregate({ where: { status: 'OPEN', departureDate: { gte: today }, package: { status: 'PUBLISHED', deletedAt: null } }, _sum: { seatsTotal: true, seatsReserved: true } }),
      this.prisma.packageDeparture.count({ where: { status: { in: ['OPEN', 'SOLD_OUT', 'CLOSED'] }, departureDate: { gte: today, lte: new Date(today.getTime() + 30 * DAY) } } }),
      this.prisma.booking.aggregate({ where: { ...live, status: { notIn: ['DRAFT', 'CANCELLED'] } }, _sum: { grandTotal: true } }),
      this.prisma.booking.findMany({ where: { ...live, status: { not: 'DRAFT' } }, orderBy: { createdAt: 'desc' }, take: 6, include: detailInclude }),
    ]);

    const counts: Partial<Record<BookingStatusKey, number>> = {};
    for (const r of byStatus) counts[r.status as BookingStatusKey] = r._count._all;
    const total = byStatus.reduce((n, r) => n + r._count._all, 0);

    return {
      generatedAt: now.toISOString(),
      bookings: { total, byStatus: counts, awaitingAction: counts.PENDING_PAYMENT ?? 0, createdLast7Days: last7 },
      revenue: {
        currency: 'PKR',
        bookedValue: fromMinor(toMinor(value._sum.grandTotal?.toString() ?? '0')),
        note: 'Total value of submitted, non-cancelled bookings. Payments received are tracked from Phase 7.',
      },
      customers: { total: customers, newLast30Days: newCustomers },
      catalog: {
        publishedPackages: published,
        openDepartures,
        seatsLeft: Math.max(0, (seats._sum.seatsTotal ?? 0) - (seats._sum.seatsReserved ?? 0)),
        departuresLeavingIn30Days: leaving,
      },
      recentBookings: recent.map((b) => this.bookings.summary(b)),
    };
  }
}
