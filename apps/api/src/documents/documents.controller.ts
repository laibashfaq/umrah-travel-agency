import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  adminDocumentQuery,
  adminVisaQuery,
  documentReviewSchema,
  staffUploadQuerySchema,
  uploadQuerySchema,
  visaAssignSchema,
  visaUpdateSchema,
} from '@umrah/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermissions, UserTypes } from '../auth/decorators';
import { ZodPipe } from '../common/http/zod.pipe';
import { ApiZodBody, ApiZodQuery } from '../docs/zod-openapi';
import { DocumentsService, type DownloadedFile } from './documents.service';
import { VisaService } from './visa.service';

const write = (limit: number) => ({ default: { limit, ttl: 60_000 } });
const uuid = new ParseUUIDPipe();

/** Sends a private file. It is never cached, never rendered by the browser, and never sniffed into another type. */
function send(res: Response, file: DownloadedFile): StreamableFile {
  res.set({
    'Content-Type': file.mime,
    'Content-Disposition': `attachment; filename="${file.fileName.replace(/[^\w. ()-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    'Content-Length': String(file.body.length),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  return new StreamableFile(file.body);
}

/** A customer's own documents and visa progress. */
@ApiTags('customer portal')
@ApiBearerAuth()
@UserTypes('CUSTOMER')
@Controller('me')
export class CustomerDocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly visas: VisaService,
    private readonly audit: AuditService,
  ) {}

  @Get('documents')
  list(@CurrentUser() user: AuthUser) {
    return this.documents.listMine(user);
  }

  @Post('documents')
  @Throttle(write(20))
  @ApiOperation({ summary: 'Upload a document', description: 'The file is the raw request body (Content-Type: application/octet-stream, up to 5 MB, PDF/JPEG/PNG). Type, traveler and file name go in the query string.' })
  @ApiZodQuery(uploadQuerySchema)
  upload(@CurrentUser() user: AuthUser, @Query(new ZodPipe(uploadQuerySchema)) query: z.infer<typeof uploadQuerySchema>, @Req() req: Request) {
    return this.documents.uploadMine(user, query, req.body, this.audit.context(req));
  }

  @Get('documents/:id/file')
  async download(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.documents.downloadMine(user, id, this.audit.context(req)));
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @Throttle(write(30))
  async remove(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Req() req: Request) {
    await this.documents.deleteMine(user, id, this.audit.context(req));
  }

  @Get('visas')
  listVisas(@CurrentUser() user: AuthUser) {
    return this.visas.listMine(user);
  }
}

/** Document review and visa work for staff. */
@ApiTags('admin')
@ApiBearerAuth('bearer')
@Controller('admin')
export class AdminDocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly visas: VisaService,
    private readonly audit: AuditService,
  ) {}

  @Get('documents')
  @RequirePermissions('documents:read')
  @ApiZodQuery(adminDocumentQuery)
  list(@Query(new ZodPipe(adminDocumentQuery)) q: z.infer<typeof adminDocumentQuery>) {
    return this.documents.list(q);
  }

  @Get('travelers/:id/documents')
  @RequirePermissions('documents:read')
  forTraveler(@Param('id', uuid) id: string) {
    return this.documents.forTraveler(id);
  }

  @Post('documents')
  @RequirePermissions('documents:create')
  @Throttle(write(30))
  @ApiOperation({ summary: 'Attach a document to a traveler', description: 'Raw body like the customer upload; staff may also attach visas, tickets and vouchers.' })
  @ApiZodQuery(staffUploadQuerySchema)
  upload(@CurrentUser() user: AuthUser, @Query(new ZodPipe(staffUploadQuerySchema)) query: z.infer<typeof staffUploadQuerySchema>, @Req() req: Request) {
    return this.documents.uploadForTraveler(user, query as typeof query & { travelerId: string }, req.body, this.audit.context(req));
  }

  @Get('documents/:id/file')
  @RequirePermissions('documents:download')
  async download(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.documents.downloadStaff(user, id, this.audit.context(req)));
  }

  @Post('documents/:id/review')
  @HttpCode(200)
  @RequirePermissions('documents:review')
  @Throttle(write(120))
  @ApiZodBody(documentReviewSchema)
  review(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(documentReviewSchema)) body: z.infer<typeof documentReviewSchema>, @Req() req: Request) {
    return this.documents.review(user, id, body, this.audit.context(req));
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @RequirePermissions('documents:delete')
  async remove(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Req() req: Request) {
    await this.documents.deleteStaff(user, id, this.audit.context(req));
  }

  /* --------------------------------- visas --------------------------------- */

  @Get('visas')
  @RequirePermissions('visas:read')
  @ApiZodQuery(adminVisaQuery)
  listVisas(@Query(new ZodPipe(adminVisaQuery)) q: z.infer<typeof adminVisaQuery>) {
    return this.visas.list(q);
  }

  @Get('visas/officers')
  @RequirePermissions('visas:read')
  officers() {
    return this.visas.officers();
  }

  @Get('visas/:id')
  @RequirePermissions('visas:read')
  getVisa(@Param('id', uuid) id: string) {
    return this.visas.get(id);
  }

  @Get('bookings/:id/visas')
  @RequirePermissions('visas:read')
  bookingVisas(@Param('id', uuid) id: string) {
    return this.visas.forBooking(id);
  }

  @Post('bookings/:id/visas')
  @RequirePermissions('visas:create')
  @Throttle(write(30))
  start(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Req() req: Request) {
    return this.visas.startForBooking(user, id, this.audit.context(req));
  }

  @Post('visas/:id/status')
  @HttpCode(200)
  @RequirePermissions('visas:update')
  @Throttle(write(120))
  @ApiZodBody(visaUpdateSchema)
  changeVisa(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(visaUpdateSchema)) body: z.infer<typeof visaUpdateSchema>, @Req() req: Request) {
    return this.visas.changeStatus(user, id, body, this.audit.context(req));
  }

  @Post('visas/:id/assign')
  @HttpCode(200)
  @RequirePermissions('visas:assign')
  @Throttle(write(60))
  @ApiZodBody(visaAssignSchema)
  assignVisa(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(visaAssignSchema)) body: z.infer<typeof visaAssignSchema>, @Req() req: Request) {
    return this.visas.assign(user, id, body.assignedOfficerId, this.audit.context(req));
  }
}

