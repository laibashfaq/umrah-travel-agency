import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const TTL_MS = 60_000;

/** Reads admin-managed settings with a short in-process cache. Secrets never live here (see env). */
@Injectable()
export class SettingsService {
  private readonly cache = new Map<string, { value: unknown; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
    const row = await this.prisma.setting.findUnique({ where: { key }, select: { value: true } });
    const value = (row?.value ?? fallback) as T;
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  /** Call after an admin changes a setting so the change applies immediately on this instance. */
  invalidate(key?: string): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
