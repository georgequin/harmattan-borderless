import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter } from './common/http-exception.filter';

/** Shared by main.ts, the e2e tests and the OpenAPI export so all three behave identically. */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Harmattan API')
    .setDescription(
      'Stablecoin cross-border payments sandbox: multi-currency wallets, deposits, FX swaps and ' +
        'transfers across cNGN, cGHS, cXAF, USDx and EURx.\n\n' +
        'Amounts are decimal strings with up to 6 decimal places. Every money-moving POST ' +
        'requires an `Idempotency-Key` header.',
    )
    .setVersion('1.0.0')
    .build();
  return SwaggerModule.createDocument(app, config);
}
