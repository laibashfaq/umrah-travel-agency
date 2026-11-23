import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { PortalModule } from '../modules/portal/portal.module';
import { AdminBookingsService } from './admin-bookings.service';
import { AdminCatalogService } from './admin-catalog.service';
import { AdminCustomersService } from './admin-customers.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminPortalController } from './admin-portal.controller';
import { AdminController } from './admin.controller';

@Module({
  imports: [PortalModule, FinanceModule],
  controllers: [AdminController, AdminPortalController],
  providers: [AdminBookingsService, AdminCatalogService, AdminCustomersService, AdminDashboardService],
})
export class AdminModule {}
