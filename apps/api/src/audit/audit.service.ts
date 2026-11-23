import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuditLogEntryDto } from '@umrah/shared';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { clientContext } from '../common/http/request-context';
import { redact } from './redact';
import type { Request } from 'express';

export interface AuditEvent {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  actorType?: 'USER' | 'SYSTEM' | 'WEBHOOK';
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

type Tx = Pick<PrismaService, 'auditLog'>;

export interface AuditQuery {
  actorUserId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Request metadata (IP, user agent, request id) for an audit entry. */
  context(req: Request) {
    return clientContext(req, this.env.INTERNAL_API_KEY);
  }

  /**
   * Appends an audit entry. Pass the transaction client as `tx` so the entry commits with the change it describes
   * (required for sensitive admin mutations). Without `tx` the write is best-effort and never breaks the request.
   */
  async record(event: AuditEvent, tx?: Tx): Promise<void> {
    const data: Prisma.AuditLogUncheckedCreateInput = {
      actorType: event.actorType ?? (event.actorUserId ? 'USER' : 'SYSTEM'),
      actorUserId: event.actorUserId ?? null,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      before: event.before === undefined ? undefined : (redact(event.before) as Prisma.InputJsonValue),
      after: event.after === undefined ? undefined : (redact(event.after) as Prisma.InputJsonValue),
      metadata: event.metadata === undefined ? undefined : (redact(event.metadata) as Prisma.InputJsonValue),
      ipAddress: event.ip ?? null,
      userAgent: event.userAgent ?? null,
      requestId: event.requestId ?? null,
    };
    if (tx) {
      await tx.auditLog.create({ data });
      return;
    }
    try {
      await this.prisma.auditLog.create({ data });
    } catch (e) {
      this.log.error(`Failed to write audit entry ${event.action}`, e instanceof Error ? e.stack : String(e));
    }
  }

  async list(q: AuditQuery): Promise<{ items: AuditLogEntryDto[]; meta: { total: number; page: number; pageSize: number; pageCount: number } }> {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const total = await this.prisma.auditLog.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pageCount);
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * q.pageSize,
      take: q.pageSize,
      include: { actor: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        actorType: r.actorType,
        actor: r.actor ? { id: r.actor.id, name: `${r.actor.firstName} ${r.actor.lastName}`, email: r.actor.email } : null,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        before: r.before,
        after: r.after,
        metadata: r.metadata,
        ipAddress: r.ipAddress,
        requestId: r.requestId,
      })),
      meta: { total, page, pageSize: q.pageSize, pageCount },
    };
  }
}
