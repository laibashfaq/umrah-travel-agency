import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RoleDto } from '@umrah/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { RequirePermissions } from '../auth/decorators';
import { ZodPipe } from '../common/http/zod.pipe';
import { ApiZodQuery } from '../docs/zod-openapi';
import { PrismaService } from '../prisma/prisma.service';

const pageParams = { page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };

const auditQuery = z.object({
  actorUserId: z.uuid().optional(),
  action: z.string().trim().min(1).max(100).optional(),
  entityType: z.string().trim().min(1).max(60).optional(),
  entityId: z.string().trim().min(1).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...pageParams,
});
const staffQuery = z.object({ q: z.string().trim().min(1).max(100).optional(), ...pageParams });

/** Staff-only endpoints. Each route declares the permission it needs; the AuthGuard enforces it. */
@ApiTags('admin')
@ApiBearerAuth('bearer')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('audit-logs')
  @RequirePermissions('audit:read')
  @ApiOperation({ summary: 'Audit trail (append-only), newest first' })
  @ApiZodQuery(auditQuery)
  auditLogs(@Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>) {
    return this.audit.list(q);
  }

  @Get('roles')
  @RequirePermissions('roles:read')
  @ApiOperation({ summary: 'Roles with their permissions and member counts' })
  async roles(): Promise<RoleDto[]> {
    const rows = await this.prisma.role.findMany({
      orderBy: { name: 'asc' },
      include: { permissions: { select: { permission: { select: { key: true } } } }, _count: { select: { users: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      userCount: r._count.users,
      permissions: r.permissions.map((p) => p.permission.key).sort(),
    }));
  }

  @Get('staff')
  @RequirePermissions('staff:read')
  @ApiOperation({ summary: 'Staff accounts with role, status and two-factor state' })
  @ApiZodQuery(staffQuery)
  async staff(@Query(new ZodPipe(staffQuery)) q: z.infer<typeof staffQuery>) {
    const where = {
      type: 'STAFF' as const,
      deletedAt: null,
      ...(q.q
        ? { OR: [{ email: { contains: q.q, mode: 'insensitive' as const } }, { firstName: { contains: q.q, mode: 'insensitive' as const } }, { lastName: { contains: q.q, mode: 'insensitive' as const } }] }
        : {}),
    };
    const total = await this.prisma.user.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pageCount);
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      skip: (page - 1) * q.pageSize,
      take: q.pageSize,
      select: { id: true, email: true, firstName: true, lastName: true, status: true, twoFactorEnabled: true, lastLoginAt: true, roles: { select: { role: { select: { key: true, name: true } } } } },
    });
    return {
      items: rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: `${u.firstName} ${u.lastName}`,
        status: u.status,
        twoFactorEnabled: u.twoFactorEnabled,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        roles: u.roles.map((r) => r.role),
      })),
      meta: { total, page, pageSize: q.pageSize, pageCount },
    };
  }
}
