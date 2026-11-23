/**
 * Removes data created by the automated browser tests (packages named e2e-*, their bookings and the test customers' travelers).
 * Refuses to run in production.
 *
 *   npm run test:cleanup -w @umrah/api
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

loadEnv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to delete data in production.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    const packages = await prisma.package.findMany({ where: { slug: { startsWith: 'e2e-' } }, select: { id: true } });
    const ids = packages.map((p) => p.id);
    const customers = await prisma.customer.findMany({ where: { email: { startsWith: 'e2e-' } }, select: { id: true } });
    const customerIds = customers.map((c) => c.id);
    const owned = { OR: [{ booking: { packageId: { in: ids } } }, { booking: { customerId: { in: customerIds } } }] };
    // Uploaded files first (the bytes on disk), then the records that point at them.
    const docs = await prisma.document.findMany({ where: { customerId: { in: customerIds } }, select: { storageKey: true } });
    const storageRoot = path.resolve(__dirname, '../../../', process.env.STORAGE_LOCAL_DIR ?? '.local/storage');
    for (const d of docs) await rm(path.join(storageRoot, d.storageKey), { force: true });
    await prisma.document.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.visaApplication.deleteMany({ where: owned });
    await prisma.refund.deleteMany({ where: owned });
    await prisma.payment.deleteMany({ where: owned });
    await prisma.invoice.deleteMany({ where: owned });
    const bookings = await prisma.booking.deleteMany({ where: { OR: [{ packageId: { in: ids } }, { customerId: { in: customerIds } }] } });
    const travelers = await prisma.traveler.deleteMany({ where: { customerId: { in: customerIds } } });
    const removedCustomers = await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.packageDeparture.deleteMany({ where: { packageId: { in: ids } } });
    const removed = await prisma.package.deleteMany({ where: { id: { in: ids } } });
    console.log(`Removed ${removed.count} test packages, ${bookings.count} bookings, ${travelers.count} travelers, ${removedCustomers.count} customers.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
