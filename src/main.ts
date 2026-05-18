import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import Big from 'big.js';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

// Configuración global de Big.js. ROUND_HALF_UP es el estándar comercial
// (1.005 → 1.01). DP=10 dígitos decimales internos antes del redondeo final
// que aplican los helpers de `common/utils/precision.ts`.
Big.RM = Big.roundHalfUp;
Big.DP = 10;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Logger estructurado (Pino) reemplaza al logger nativo de Nest.
  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);
  const appConfig = configService.getOrThrow<AppConfig>('app');

  // Seguridad HTTP headers.
  app.use(helmet());

  // CORS — orígenes desde env. Lista vacía = reflejo del Origin (solo dev).
  app.enableCors({
    origin: appConfig.corsOrigins.length > 0 ? appConfig.corsOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  });

  // Prefijo global. Por defecto vacío — el cliente PlacePos llama al API en
  // raíz (`/sales`, `/auth/user`, ...). Si `API_PREFIX` se define en env
  // (escenarios donde un reverse proxy quiere segmentar), lo aplicamos.
  if (appConfig.apiPrefix !== '') {
    app.setGlobalPrefix(appConfig.apiPrefix);
  }

  // Versionado URI disponible pero INACTIVO por default. Para introducir un
  // contrato `/v2/...` futuro sin breaking change basta con poner
  // `@Version('2')` en los controllers nuevos. Sin `defaultVersion`, los
  // controllers actuales quedan en raíz.
  app.enableVersioning({
    type: VersioningType.URI,
  });

  // Validación global estricta de payloads.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Trust proxy — necesario tras load balancer / reverse proxy para que
  // `req.ip` (y el throttler) usen la IP real del cliente vía X-Forwarded-For,
  // no la del proxy. Sin esto, todos los usuarios detrás del LB compartirían
  // cubo de rate limit (o un atacante saltaría buckets escondiéndose tras el
  // mismo proxy).
  //
  // Valores válidos para Express:
  //   - número: hops a confiar (0 = directo, 1 = tras 1 proxy).
  //   - boolean: true confía en TODOS (peligroso), false desactiva.
  //   - string: 'loopback' | 'linklocal' | 'uniquelocal'.
  // En dev/test típicamente 0; en prod ajustar al número de proxies reales.
  const trustProxy = configService.get<number | boolean | string>('TRUST_PROXY');
  if (trustProxy !== undefined && trustProxy !== false && trustProxy !== 0) {
    const expressApp = app.getHttpAdapter().getInstance() as unknown as {
      set(setting: string, val: unknown): void;
    };
    expressApp.set('trust proxy', trustProxy);
  }

  // Apagado limpio para gestores de proceso (Docker, k8s, PM2).
  app.enableShutdownHooks();

  // Swagger / OpenAPI — solo si está habilitado por env.
  if (appConfig.swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('POS API')
      .setDescription('API del sistema POS (Punto de Venta).')
      .setVersion(process.env.npm_package_version ?? '0.1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token JWT (se habilitará al añadir el módulo de auth).',
        },
        'bearer',
      )
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    // Docs siempre disponibles en `/docs`. Si en el futuro se vuelve a fijar
    // un prefix por env, prefijamos para mantener coherencia con el resto.
    const docsPath = appConfig.apiPrefix !== '' ? `${appConfig.apiPrefix}/docs` : 'docs';
    SwaggerModule.setup(docsPath, app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  await app.listen(appConfig.port);

  const logger = app.get(Logger);
  const baseUrl = `http://localhost:${appConfig.port}${
    appConfig.apiPrefix !== '' ? `/${appConfig.apiPrefix}` : ''
  }`;
  logger.log(`POS API escuchando en ${baseUrl} (env: ${appConfig.nodeEnv})`);
  if (appConfig.swaggerEnabled) {
    logger.log(`Swagger disponible en ${baseUrl}/docs`);
  }
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Error fatal arrancando la aplicación:', error);
  process.exit(1);
});
