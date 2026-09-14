import { Body, Controller, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';

/**
 * Controlador mínimo para probar el body parser: devuelve el tamaño del body
 * recibido y si `req.rawBody` (el Buffer crudo que firma el
 * `SuperadminSignatureGuard`) quedó disponible.
 */
@Controller('probe')
class ProbeController {
  @Post('echo')
  echo(@Body() body: { blob?: string }, @Req() req: RawBodyRequest<Request>) {
    return {
      length: body?.blob?.length ?? 0,
      hasRawBody: Buffer.isBuffer(req.rawBody),
    };
  }
}

/**
 * Regresión del límite del body parser en `main.ts`.
 *
 * El import de respaldos de tenant (superadmin) manda snapshots JSON de varios
 * MB. El default de body-parser (~100kb) los rechaza con 413, por eso `main.ts`
 * sube el límite con `app.useBodyParser('json', { limit: '64mb' })`.
 *
 * TRAMPA (el bug que motivó estos tests): el wrapper `NestApplication.useBodyParser`
 * NO tiene la firma `(type, rawBody, options)` — su firma pública es
 * `(type, options)` y él mismo INYECTA `rawBody` desde las appOptions. Si se le
 * pasa `rawBody` a mano (`useBodyParser('json', true, { limit })`), el `{ limit }`
 * cae en la posición equivocada y se DESCARTA → vuelve el default de 100kb.
 *
 * Estos tests fijan el comportamiento correcto y documentan el modo con bug.
 */
describe('Body parser limit (e2e)', () => {
  // ~1MB de JSON: supera el default de 100kb pero cabe holgado en 64mb.
  const bigBlob = 'x'.repeat(1_000_000);

  async function bootApp(
    configure: (app: NestExpressApplication) => void,
  ): Promise<NestExpressApplication> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();

    // `rawBody: true` reproduce el `NestFactory.create({ rawBody: true })` real,
    // para que el wrapper inyecte el `verify` que captura `req.rawBody`.
    const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    configure(app);
    await app.init();
    return app;
  }

  describe('configuración correcta (como main.ts)', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      app = await bootApp((a) => a.useBodyParser('json', { limit: '64mb' }));
    });

    afterAll(async () => {
      await app.close();
    });

    it('acepta un body JSON grande (>100kb) sin 413', async () => {
      const response = await request(app.getHttpServer())
        .post('/probe/echo')
        .send({ blob: bigBlob });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.length).toBe(bigBlob.length);
    });

    it('preserva req.rawBody (firma superadmin) junto con el límite ampliado', async () => {
      const response = await request(app.getHttpServer())
        .post('/probe/echo')
        .send({ blob: 'hola' });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.hasRawBody).toBe(true);
    });
  });

  describe('default (sin subir el límite)', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      // Sin `useBodyParser`: Nest registra el parser con el default de ~100kb.
      app = await bootApp(() => undefined);
    });

    afterAll(async () => {
      await app.close();
    });

    it('rechaza un body JSON grande con 413 (control negativo)', async () => {
      const response = await request(app.getHttpServer())
        .post('/probe/echo')
        .send({ blob: bigBlob });

      expect(response.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    });
  });

  describe('modo con bug (rawBody pasado a mano)', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      // Reproduce el error histórico: pasar `rawBody` (true) desplaza el
      // `{ limit }` a la posición equivocada y se descarta → vuelve el default.
      app = await bootApp((a) =>
        (a.useBodyParser as unknown as (t: string, r: boolean, o: { limit: string }) => void)(
          'json',
          true,
          { limit: '64mb' },
        ),
      );
    });

    afterAll(async () => {
      await app.close();
    });

    it('el body grande vuelve a fallar con 413 (demuestra por qué el arg extra rompe)', async () => {
      const response = await request(app.getHttpServer())
        .post('/probe/echo')
        .send({ blob: bigBlob });

      expect(response.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    });
  });
});
