import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  bookingCreateSchema,
  bookingTravelersSchema,
  cancelBookingSchema,
  profileUpdateSchema,
  quoteRequestSchema,
  travelerInputSchema,
} from '@umrah/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import { CurrentUser, UserTypes } from '../../auth/decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ApiZodBody, ApiZodQuery } from '../../docs/zod-openapi';
import { BookingsService } from './bookings.service';
import { ProfileService } from './profile.service';
import { TravelersService } from './travelers.service';

const listQuery = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(10) });
const write = (limit: number) => ({ default: { limit, ttl: 60_000 } });

/** Everything a signed-in customer can do with their own data. Ownership is enforced in the services, not trusted from ids. */
@ApiTags('customer portal')
@ApiBearerAuth()
@UserTypes('CUSTOMER')
@Controller('me')
export class PortalController {
  constructor(
    private readonly profile: ProfileService,
    private readonly travelers: TravelersService,
    private readonly bookings: BookingsService,
    private readonly audit: AuditService,
  ) {}

  /* -------------------------------- profile -------------------------------- */

  @Get('profile')
  getProfile(@CurrentUser() user: AuthUser) {
    return this.profile.get(user);
  }

  @Put('profile')
  @Throttle(write(20))
  @ApiZodBody(profileUpdateSchema)
  updateProfile(@CurrentUser() user: AuthUser, @Body(new ZodPipe(profileUpdateSchema)) body: z.infer<typeof profileUpdateSchema>, @Req() req: Request) {
    return this.profile.update(user, body, this.audit.context(req));
  }

  /* ------------------------------- travelers ------------------------------- */

  @Get('travelers')
  listTravelers(@CurrentUser() user: AuthUser) {
    return this.travelers.list(user);
  }

  @Get('travelers/:id')
  getTraveler(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.travelers.get(user, id);
  }

  @Post('travelers')
  @Throttle(write(30))
  @ApiZodBody(travelerInputSchema)
  createTraveler(@CurrentUser() user: AuthUser, @Body(new ZodPipe(travelerInputSchema)) body: z.infer<typeof travelerInputSchema>, @Req() req: Request) {
    return this.travelers.create(user, body, this.audit.context(req));
  }

  @Put('travelers/:id')
  @Throttle(write(30))
  @ApiZodBody(travelerInputSchema)
  updateTraveler(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(travelerInputSchema)) body: z.infer<typeof travelerInputSchema>,
    @Req() req: Request,
  ) {
    return this.travelers.update(user, id, body, this.audit.context(req));
  }

  @Delete('travelers/:id')
  @HttpCode(204)
  @Throttle(write(30))
  async deleteTraveler(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.travelers.remove(user, id, this.audit.context(req));
  }

  /* -------------------------------- bookings -------------------------------- */

  @Get('departures/:id')
  @ApiOperation({ summary: 'Room options and prices for a departure' })
  departure(@Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.departureOptions(id);
  }

  @Post('bookings/quote')
  @HttpCode(200)
  @Throttle(write(60))
  @ApiOperation({ summary: 'Price a room plan on a departure', description: 'Computed on the server from current prices. Nothing is reserved.' })
  @ApiZodBody(quoteRequestSchema)
  quote(@Body(new ZodPipe(quoteRequestSchema)) body: z.infer<typeof quoteRequestSchema>) {
    return this.bookings.quote(body);
  }

  @Post('bookings')
  @Throttle(write(10))
  @ApiOperation({ summary: 'Start a booking', description: 'Creates a draft and holds the seats for 60 minutes.' })
  @ApiZodBody(bookingCreateSchema)
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(bookingCreateSchema)) body: z.infer<typeof bookingCreateSchema>, @Req() req: Request) {
    return this.bookings.createDraft(user, body, this.audit.context(req));
  }

  @Get('bookings')
  @ApiZodQuery(listQuery)
  listBookings(@CurrentUser() user: AuthUser, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.bookings.list(user, q.page, q.pageSize);
  }

  @Get('bookings/:id')
  getBooking(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.get(user, id);
  }

  @Put('bookings/:id/travelers')
  @Throttle(write(30))
  @ApiZodBody(bookingTravelersSchema)
  setTravelers(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(bookingTravelersSchema)) body: z.infer<typeof bookingTravelersSchema>,
    @Req() req: Request,
  ) {
    return this.bookings.setTravelers(user, id, body, this.audit.context(req));
  }

  @Post('bookings/:id/submit')
  @HttpCode(200)
  @Throttle(write(10))
  submit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.bookings.submit(user, id, this.audit.context(req));
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  @Throttle(write(10))
  @ApiZodBody(cancelBookingSchema)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(cancelBookingSchema)) body: z.infer<typeof cancelBookingSchema>,
    @Req() req: Request,
  ) {
    return this.bookings.cancel(user, id, body.reason, this.audit.context(req));
  }
}
