/**
 * Creates a published package with one open departure for browser tests and prints it as JSON.
 * Refuses to run in production. Demo data ages (its dates pass), so tests make their own.
 *
 *   npm run test:departure -w @umrah/api -- --seats 12
 */
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

loadEnv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const day = (offset: number) => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + offset));
};

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to create test data in production.');
  const seats = Number(arg('seats') ?? 12);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    const slug = `e2e-journey-${Date.now().toString(36)}`;
    const pkg = await prisma.package.create({
      data: {
        slug,
        title: 'E2E Journey Package',
        durationDays: 14,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        depositType: 'PERCENTAGE',
        depositValue: 25,
        departures: {
          create: {
            departureDate: day(60),
            returnDate: day(74),
            departureCity: 'Karachi',
            seatsTotal: seats,
            status: 'OPEN',
            prices: {
              create: [
                { occupancy: 'DOUBLE', adultPrice: '300000.00', childPrice: '250000.00', infantPrice: '40000.00' },
                { occupancy: 'QUAD', adultPrice: '260000.00' },
              ],
            },
          },
        },
      },
      include: { departures: true },
    });
    console.log(JSON.stringify({ slug, packageId: pkg.id, departureId: pkg.departures[0]!.id, returnDate: day(74).toISOString().slice(0, 10) }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
