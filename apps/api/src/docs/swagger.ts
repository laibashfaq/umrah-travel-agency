import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Env } from '../config/env';

/** Interactive OpenAPI docs at /api/docs (JSON at /api/docs-json). On by default outside production. */
export function setupSwagger(app: INestApplication, env: Env): boolean {
  const enabled = env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production';
  if (!enabled) return false;
  const config = new DocumentBuilder()
    .setTitle('Umrah Travel Platform API')
    .setDescription(
      'Public catalog and content (unauthenticated), customer and staff authentication, and permission-protected admin endpoints.\n\n' +
        'Authenticate with `POST /auth/login`, then send `Authorization: Bearer <accessToken>`. Access tokens last 15 minutes; use `POST /auth/refresh`.',
    )
    .setVersion('1.0')
    .setOpenAPIVersion('3.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    .addServer(env.API_URL)
    .build();
  const document = SwaggerModule.createDocument(app, config, { ignoreGlobalPrefix: false });
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs-json', swaggerOptions: { persistAuthorization: true } });
  return true;
}
