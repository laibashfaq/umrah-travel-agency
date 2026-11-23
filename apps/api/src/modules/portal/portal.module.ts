import { Module } from '@nestjs/common';
import { FinanceModule } from '../../finance/finance.module';
import { BookingsService } from './bookings.service';
import { PortalController } from './portal.controller';
import { ProfileService } from './profile.service';
import { TravelersService } from './travelers.service';

@Module({ imports: [FinanceModule], providers: [ProfileService, TravelersService, BookingsService], controllers: [PortalController], exports: [BookingsService] })
export class PortalModule {}
