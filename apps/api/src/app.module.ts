import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { DocumentsModule } from './documents/documents.module';
import { StorageModule } from './storage/storage.service';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AppThrottlerGuard } from './common/http/throttle.guard';
import { ConfigModule } from './config/config.module';
import { HealthController } from './health/health.controller';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CmsModule } from './modules/cms/cms.module';
import { MailModule } from './mail/mail.module';
import { PortalModule } from './modules/portal/portal.module';
import { LeadsModule } from './modules/leads/leads.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { SeoModule } from './modules/seo/seo.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsModule } from './settings/settings.service';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    CommonModule,
    CryptoModule,
    AuditModule,
    MailModule,
    SettingsModule,
    AuthModule,
    AdminModule,
    // Generous global default (reads are cached at the CDN); write endpoints add stricter @Throttle limits.
    // In-memory store is per instance; swap for a Redis store when running multiple API instances.
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }] }),
    CatalogModule,
    StorageModule,
    DocumentsModule,
    PortalModule,
    CmsModule,
    ReviewsModule,
    LeadsModule,
    SeoModule,
  ],
  controllers: [HealthController],
  // Order matters: rate-limit first, then authenticate/authorise (default deny; routes opt out with @Public()).
  providers: [
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
