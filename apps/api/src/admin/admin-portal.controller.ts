import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  adminBookingQuery,
  adminCustomerQuery,
  adminPackageQuery,
  bookingAssignSchema,
  bookingStatusChangeSchema,
  departureInputSchema,
  noteSchema,
  packageInputSchema,
  packageStatusSchema,
} from '@umrah/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { ZodPipe } from '../common/http/zod.pipe';
import { ApiZodBody, ApiZodQuery } from '../docs/zod-openapi';
import { AdminBookingsService } from './admin-bookings.service';
import { AdminCatalogService } from './admin-catalog.service';
import { AdminCustomersService } from './admin-customers.service';
import { AdminDashboardService } from './admin-dashboard.service';

const write = (limit: number) => ({ default: { limit, ttl: 60_000 } });
const uuid = new ParseUUIDPipe();

/** Staff operations on bookings, customers and the catalogue. Every route names the permission it needs. */
@ApiTags('admin')
@ApiBearerAuth('bearer')
@Controller('admin')
export class AdminPortalController {
  constructor(
    private readonly dashboard: AdminDashboardService,
    private readonly bookings: AdminBookingsService,
    private readonly customers: AdminCustomersService,
    private readonly catalog: AdminCatalogService,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------- dashboard ------------------------------- */

  @Get('dashboard')
  @RequirePermissions('dashboard:read')
  stats() {
    return this.dashboard.stats();
  }

  /* -------------------------------- bookings -------------------------------- */

  @Get('bookings')
  @RequirePermissions('bookings:read')
  @ApiZodQuery(adminBookingQuery)
  listBookings(@Query(new ZodPipe(adminBookingQuery)) q: z.infer<typeof adminBookingQuery>) {
    return this.bookings.list(q);
  }

  @Get('bookings/assignees')
  @RequirePermissions('bookings:read')
  assignees() {
    return this.bookings.assignees();
  }

  @Get('bookings/:id')
  @RequirePermissions('bookings:read')
  getBooking(@Param('id', uuid) id: string) {
    return this.bookings.get(id);
  }

  @Post('bookings/:id/status')
  @HttpCode(200)
  @RequirePermissions('bookings:read')
  @Throttle(write(60))
  @ApiOperation({ summary: 'Move a booking along its workflow', description: 'Needs bookings:update, or bookings:cancel to cancel. Cancelling requires a reason and releases the seats.' })
  @ApiZodBody(bookingStatusChangeSchema)
  changeStatus(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(bookingStatusChangeSchema)) body: z.infer<typeof bookingStatusChangeSchema>, @Req() req: Request) {
    return this.bookings.changeStatus(user, id, body, this.audit.context(req));
  }

  @Post('bookings/:id/assign')
  @HttpCode(200)
  @RequirePermissions('bookings:assign')
  @Throttle(write(60))
  @ApiZodBody(bookingAssignSchema)
  assign(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(bookingAssignSchema)) body: z.infer<typeof bookingAssignSchema>, @Req() req: Request) {
    return this.bookings.assign(user, id, body.assignedToId, this.audit.context(req));
  }

  @Post('bookings/:id/notes')
  @RequirePermissions('bookings:update')
  @Throttle(write(60))
  @ApiZodBody(noteSchema)
  addBookingNote(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(noteSchema)) body: z.infer<typeof noteSchema>, @Req() req: Request) {
    return this.bookings.addNote(user, id, body.body, this.audit.context(req));
  }

  /* -------------------------------- customers -------------------------------- */

  @Get('customers')
  @RequirePermissions('customers:read')
  @ApiZodQuery(adminCustomerQuery)
  listCustomers(@Query(new ZodPipe(adminCustomerQuery)) q: z.infer<typeof adminCustomerQuery>) {
    return this.customers.list(q);
  }

  @Get('customers/:id')
  @RequirePermissions('customers:read')
  getCustomer(@Param('id', uuid) id: string) {
    return this.customers.get(id);
  }

  @Post('customers/:id/notes')
  @RequirePermissions('customers:update')
  @Throttle(write(60))
  @ApiZodBody(noteSchema)
  addCustomerNote(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(noteSchema)) body: z.infer<typeof noteSchema>, @Req() req: Request) {
    return this.customers.addNote(user, id, body.body, this.audit.context(req));
  }

  /* -------------------------------- packages -------------------------------- */

  @Get('packages')
  @RequirePermissions('packages:read')
  @ApiZodQuery(adminPackageQuery)
  listPackages(@Query(new ZodPipe(adminPackageQuery)) q: z.infer<typeof adminPackageQuery>) {
    return this.catalog.list(q);
  }

  @Get('packages/:id')
  @RequirePermissions('packages:read')
  getPackage(@Param('id', uuid) id: string) {
    return this.catalog.get(id);
  }

  @Post('packages')
  @RequirePermissions('packages:create')
  @Throttle(write(30))
  @ApiZodBody(packageInputSchema)
  createPackage(@CurrentUser() user: AuthUser, @Body(new ZodPipe(packageInputSchema)) body: z.infer<typeof packageInputSchema>, @Req() req: Request) {
    return this.catalog.create(user, body, this.audit.context(req));
  }

  @Put('packages/:id')
  @RequirePermissions('packages:update')
  @Throttle(write(60))
  @ApiZodBody(packageInputSchema)
  updatePackage(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(packageInputSchema)) body: z.infer<typeof packageInputSchema>, @Req() req: Request) {
    return this.catalog.update(user, id, body, this.audit.context(req));
  }

  @Post('packages/:id/status')
  @HttpCode(200)
  @RequirePermissions('packages:publish')
  @Throttle(write(30))
  @ApiOperation({ summary: 'Publish, unpublish or archive a package', description: 'Publishing needs an upcoming open departure with at least one price.' })
  @ApiZodBody(packageStatusSchema)
  setPackageStatus(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(packageStatusSchema)) body: z.infer<typeof packageStatusSchema>, @Req() req: Request) {
    return this.catalog.setStatus(user, id, body.status, this.audit.context(req));
  }

  @Post('packages/:id/departures')
  @RequirePermissions('departures:create')
  @Throttle(write(60))
  @ApiZodBody(departureInputSchema)
  createDeparture(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(departureInputSchema)) body: z.infer<typeof departureInputSchema>, @Req() req: Request) {
    return this.catalog.createDeparture(user, id, body, this.audit.context(req));
  }

  @Put('packages/:id/departures/:departureId')
  @RequirePermissions('departures:update')
  @Throttle(write(60))
  @ApiZodBody(departureInputSchema)
  updateDeparture(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('departureId', uuid) departureId: string,
    @Body(new ZodPipe(departureInputSchema)) body: z.infer<typeof departureInputSchema>,
    @Req() req: Request,
  ) {
    return this.catalog.updateDeparture(user, id, departureId, body, this.audit.context(req));
  }

  @Delete('packages/:id/departures/:departureId')
  @RequirePermissions('departures:delete')
  @Throttle(write(30))
  deleteDeparture(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Param('departureId', uuid) departureId: string, @Req() req: Request) {
    return this.catalog.deleteDeparture(user, id, departureId, this.audit.context(req));
  }
}
