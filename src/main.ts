import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { buildOpenApiDocument, configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  SwaggerModule.setup('docs', app, buildOpenApiDocument(app), {
    jsonDocumentUrl: 'docs/openapi.json',
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`Harmattan API on http://localhost:${port} (docs at /docs)`, 'Bootstrap');
}

void bootstrap();
