import { Module } from '@nestjs/common';
import { ReviewsModule } from '../reviews/reviews.module';
import { CatalogService } from './catalog.service';
import { PublicCatalogController } from './public-catalog.controller';
import { StartingPriceRefresher } from './starting-price.refresher';

@Module({
  imports: [ReviewsModule],
  providers: [CatalogService, StartingPriceRefresher],
  controllers: [PublicCatalogController],
  exports: [CatalogService],
})
export class CatalogModule {}
