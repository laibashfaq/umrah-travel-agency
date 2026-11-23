import { Module } from '@nestjs/common';
import { AdminFinanceController, CustomerFinanceController } from './finance.controller';
import { InvoicesService } from './invoices.service';
import { MoneyService } from './money.service';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

@Module({
  controllers: [CustomerFinanceController, AdminFinanceController],
  providers: [MoneyService, PaymentsService, RefundsService, InvoicesService],
  exports: [MoneyService, InvoicesService],
})
export class FinanceModule {}
