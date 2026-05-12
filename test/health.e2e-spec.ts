import { HttpStatus, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';

import { HealthModule } from '@/health/health.module';

/**
 * Test e2e placeholder del endpoint de liveness.
 * No requiere base de datos (liveness no toca dependencias externas).
 */
describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live debe responder 200', async () => {
    const response = await request(app.getHttpServer() as Server).get('/health/live');
    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toMatchObject({ status: 'ok' });
  });
});
