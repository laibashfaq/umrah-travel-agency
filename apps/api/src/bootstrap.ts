import type { INestApplication } from '@nestjs/common';
import { raw } from 'express';
import { MAX_DOCUMENT_BYTES } from '@umrah/shared';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { requestIdMiddleware } from './common/http/request-context';
import type { Env } from './config/env';
import { setupSwagger } from './docs/swagger';

/** Shared HTTP setup for main.ts and e2e tests. */
export function configureApp(app: INestApplication, env: Env): void {
  // Correct client IPs behind a load balancer (rate limiting, abuse logging).
  app.getHttpAdapter().getInstance().set('trust proxy', env.TRUST_PROXY);
  app.use(requestIdMiddleware);
  app.use(helmet());
  // Uploads arrive as the raw request body (metadata is in the query string), capped just above the allowed size.
  app.use(['/api/v1/me/documents', '/api/v1/admin/documents'], raw({ type: 'application/octet-stream', limit: MAX_DOCUMENT_BYTES + 1024 }));
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  setupSwagger(app, env);
}
