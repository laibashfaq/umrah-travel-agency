import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  adminInvoiceQuery,
  adminPaymentQuery,
  adminRefundQuery,
  recordPaymentSchema,
  refundActionSchema,
  reportPaymentSchema,
  requestRefundSchema,
  verifyPaymentSchema,
  voidInvoiceSchema,
} from '@umrah/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermissions, UserTypes } from '../auth/decorators';
import { ZodPipe } from '../common/http/zod.pipe';
import { ApiZodBody, ApiZodQuery } from '../docs/zod-openapi';
import { InvoicesService } from './invoices.service';
import { MoneyService } from './money.service';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';
import { PrismaService } from '../prisma/prisma.service';

const write = (limit: number) => ({ default: { limit, ttl: 60_000 } });
const uuid = new ParseUUIDPipe();

/** What a customer can see and do about money on their own bookings. */
@ApiTags('customer portal')
@ApiBearerAuth()
@UserTypes('CUSTOMER')
@Controller('me')
export class CustomerFinanceController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly invoices: InvoicesService,
    private readonly audit: AuditService,
  ) {}

  @Get('bookings/:id/money')
  money(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.payments.bookingMoney(user, id);
  }

  @Get('payments')
  listPayments(@CurrentUser() user: AuthUser) {
    return this.payments.listMine(user);
  }

  @Get('payments/:id')
  getPayment(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.payments.getMine(user, id);
  }

  @Post('payments')
  @Throttle(write(10))
  @ApiOperation({ summary: 'Tell us you have paid', description: 'Creates a payment that waits for finance to check it against the bank. It does not count until verified.' })
  @ApiZodBody(reportPaymentSchema)
  report(@CurrentUser() user: AuthUser, @Body(new ZodPipe(reportPaymentSchema)) body: z.infer<typeof reportPaymentSchema>, @Req() req: Request) {
    return this.payments.report(user, body, this.audit.context(req));
  }

  @Get('invoices')
  listInvoices(@CurrentUser() user: AuthUser) {
    return this.invoices.listMine(user);
  }

  @Get('invoices/:id')
  getInvoice(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.invoices.getMine(user, id);
  }
}

/** Finance work for staff. Each route names the permission it needs. */
@ApiTags('admin')
@ApiBearerAuth('bearer')
@Controller('admin')
export class AdminFinanceController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly invoices: InvoicesService,
    private readonly money: MoneyService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('bookings/:id/finance')
  @RequirePermissions('payments:read')
  async bookingFinance(@Param('id', uuid) id: string) {
    const [money, payments, refunds, invoices] = await Promise.all([
      this.money.summary(this.prisma, id),
      this.payments.list({ bookingId: id, page: 1, pageSize: 100 }),
      this.refunds.forBooking(id),
      this.invoices.forBooking(id),
    ]);
    return { money, payments: payments.items, refunds, invoices };
  }

  @Get('payments')
  @RequirePermissions('payments:read')
  @ApiZodQuery(adminPaymentQuery)
  listPayments(@Query(new ZodPipe(adminPaymentQuery)) q: z.infer<typeof adminPaymentQuery>) {
    return this.payments.list(q);
  }

  @Post('payments')
  @RequirePermissions('payments:create')
  @Throttle(write(60))
  @ApiOperation({ summary: 'Record money received', description: 'Counts at once when you also hold payments:verify; otherwise it waits for someone who does.' })
  @ApiZodBody(recordPaymentSchema)
  record(@CurrentUser() user: AuthUser, @Body(new ZodPipe(recordPaymentSchema)) body: z.infer<typeof recordPaymentSchema>, @Req() req: Request) {
    return this.payments.record(user, body, this.audit.context(req));
  }

  @Post('payments/:id/verify')
  @HttpCode(200)
  @RequirePermissions('payments:verify')
  @Throttle(write(60))
  @ApiZodBody(verifyPaymentSchema)
  verify(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(verifyPaymentSchema)) body: z.infer<typeof verifyPaymentSchema>, @Req() req: Request) {
    return this.payments.verify(user, id, body, this.audit.context(req));
  }

  @Get('refunds')
  @RequirePermissions('refunds:read')
  @ApiZodQuery(adminRefundQuery)
  listRefunds(@Query(new ZodPipe(adminRefundQuery)) q: z.infer<typeof adminRefundQuery>) {
    return this.refunds.list(q);
  }

  @Post('refunds')
  @RequirePermissions('refunds:create')
  @Throttle(write(30))
  @ApiZodBody(requestRefundSchema)
  requestRefund(@CurrentUser() user: AuthUser, @Body(new ZodPipe(requestRefundSchema)) body: z.infer<typeof requestRefundSchema>, @Req() req: Request) {
    return this.refunds.request(user, body, this.audit.context(req));
  }

  @Post('refunds/:id/action')
  @HttpCode(200)
  @RequirePermissions('refunds:approve')
  @Throttle(write(30))
  @ApiZodBody(refundActionSchema)
  refundAction(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(refundActionSchema)) body: z.infer<typeof refundActionSchema>, @Req() req: Request) {
    return this.refunds.act(user, id, body, this.audit.context(req));
  }

  @Get('invoices')
  @RequirePermissions('invoices:read')
  @ApiZodQuery(adminInvoiceQuery)
  listInvoices(@Query(new ZodPipe(adminInvoiceQuery)) q: z.infer<typeof adminInvoiceQuery>) {
    return this.invoices.list(q);
  }

  @Get('invoices/:id')
  @RequirePermissions('invoices:read')
  getInvoice(@Param('id', uuid) id: string) {
    return this.invoices.get(id);
  }

  @Post('bookings/:id/invoice')
  @RequirePermissions('invoices:create')
  @Throttle(write(30))
  issueInvoice(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Req() req: Request) {
    return this.invoices.issueManually(user, id, this.audit.context(req));
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  @RequirePermissions('invoices:void')
  @Throttle(write(30))
  @ApiZodBody(voidInvoiceSchema)
  voidInvoice(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(voidInvoiceSchema)) body: z.infer<typeof voidInvoiceSchema>, @Req() req: Request) {
    return this.invoices.void(user, id, body.reason, this.audit.context(req));
  }
}
