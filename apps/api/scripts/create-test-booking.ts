/**
 * Creates a customer with a submitted (PENDING_PAYMENT) booking on a fresh published package, for staff-portal
 * browser tests, and prints it as JSON. Refuses to run in production.
 *
 *   npm run test:booking -w @umrah/api -- --tag abc123 [--login]
 *
 * With --login the customer also gets a verified account (password printed in the JSON) so a browser test can sign in as them.
 */
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { FieldEncryption } from '../src/common/crypto/field-encryption';
import { PrismaClient } from '../src/generated/prisma/client';

loadEnv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const day = (offset: number) => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + offset));
};

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to create test data in production.');
  const tag = arg('tag') ?? Date.now().toString(36);
  const enc = new FieldEncryption(process.env.FIELD_ENCRYPTION_KEY!, process.env.FIELD_HASH_KEY!);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    const email = `e2e-staffview-${tag}@example.com`;
    const passport = `ST${tag.toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(7, '0').slice(0, 7)}`;
    const password = 'correct horse battery staple';
    const user = process.argv.includes('--login')
      ? await prisma.user.create({
          data: { email, firstName: 'Zainab', lastName: `Viewer${tag}`, type: 'CUSTOMER', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordChangedAt: new Date(), passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }) },
        })
      : null;
    const customer = await prisma.customer.create({ data: { userId: user?.id ?? null, firstName: 'Zainab', lastName: `Viewer${tag}`, email, phone: '+92 300 5550100' } });
    const traveler = await prisma.traveler.create({
      data: {
        customerId: customer.id,
        firstName: 'Zainab',
        lastName: `Viewer${tag}`,
        gender: 'FEMALE',
        dateOfBirth: new Date('1988-04-02T00:00:00Z'),
        nationality: 'PK',
        passportNumberEnc: enc.encrypt(passport),
        passportNumberHash: enc.hash(passport),
        passportExpiryDate: day(1200),
      },
    });
    const pkg = await prisma.package.create({
      data: {
        slug: `e2e-staffview-${tag}`,
        title: `E2E Staff View ${tag}`,
        durationDays: 14,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        depositType: 'PERCENTAGE',
        depositValue: 25,
        departures: { create: { departureDate: day(60), returnDate: day(74), seatsTotal: 10, seatsReserved: 1, status: 'OPEN', prices: { create: [{ occupancy: 'DOUBLE', adultPrice: '300000.00' }] } } },
      },
      include: { departures: true },
    });
    const departure = pkg.departures[0]!;
    const year = new Date().getUTCFullYear();
    const reference = `UMR-${year}-9${tag.replace(/\D/g, '').padEnd(5, '0').slice(0, 5)}`;
    const booking = await prisma.booking.create({
      data: {
        reference,
        customerId: customer.id,
        packageId: pkg.id,
        departureId: departure.id,
        status: process.argv.includes('--confirmed') ? 'CONFIRMED' : 'PENDING_PAYMENT',
        confirmedAt: process.argv.includes('--confirmed') ? new Date() : null,
        currentStep: 'CONFIRMATION',
        adults: 1,
        currency: 'PKR',
        subtotal: '300000.00',
        grandTotal: '300000.00',
        depositAmount: '75000.00',
        balanceDue: '300000.00',
        balanceDueDate: day(30),
        submittedAt: new Date(),
        pricingSnapshot: { quote: { rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 0, infants: 0, adultPrice: '300000.00', childPrice: '300000.00', infantPrice: '0.00', lineTotal: '300000.00' }] }, prices: {}, deposit: { type: 'PERCENTAGE', value: '25' } },
        rooms: { create: { occupancy: 'DOUBLE', label: 'Room 1', pricePerAdult: '300000.00', sortOrder: 0 } },
        statusHistory: { create: [{ fromStatus: null, toStatus: 'DRAFT', note: 'Booking started online' }, { fromStatus: 'DRAFT', toStatus: 'PENDING_PAYMENT', note: 'Submitted by customer' }] },
      },
      include: { rooms: true },
    });
    await prisma.bookingTraveler.create({ data: { bookingId: booking.id, travelerId: traveler.id, bookingRoomId: booking.rooms[0]!.id, travelerType: 'ADULT', isLeadTraveler: true, price: '300000.00' } });
    console.log(JSON.stringify({ travelerId: traveler.id, bookingId: booking.id, reference, customerId: customer.id, customerEmail: email, customerName: `Zainab Viewer${tag}`, password: user ? password : null, packageId: pkg.id, packageTitle: pkg.title, departureId: departure.id }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
