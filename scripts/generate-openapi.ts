import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument, configureApp } from '../src/app.setup';

/**
 * Writes docs/openapi.json from the live controller metadata, so the committed
 * spec cannot drift from the code. Needs no database (Prisma connects lazily).
 */
async function main(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:5432/unused';
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  const document = buildOpenApiDocument(app);
  const target = join(__dirname, '..', 'docs', 'openapi.json');
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  console.log(`OpenAPI spec written to ${target}`);
}

void main();
