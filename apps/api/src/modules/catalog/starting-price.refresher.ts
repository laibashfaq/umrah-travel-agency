import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { refreshStartingPrice } from './starting-price';

const EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Keeps each package's advertised "from" price true as time passes. The price is the cheapest open, upcoming
 * departure; when a departure's date goes by nobody edits anything, so without this the old price would stay on show.
 * Runs at start-up and every six hours. Safe to run on several instances (it only recomputes).
 */
@Injectable()
export class StartingPriceRefresher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(StartingPriceRefresher.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    void this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), EVERY_MS);
    this.timer.unref(); // never keeps the process alive
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refreshAll(): Promise<number> {
    try {
      const packages = await this.prisma.package.findMany({ where: { deletedAt: null, status: 'PUBLISHED' }, select: { id: true } });
      for (const p of packages) await refreshStartingPrice(this.prisma, p.id);
      return packages.length;
    } catch (e) {
      this.log.error(`Could not refresh starting prices: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  }
}
