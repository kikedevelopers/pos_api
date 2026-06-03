import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
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
  // `rawBody: true` expone `req.rawBody` (Buffer) además del body parseado.
  // Lo necesita `SuperadminSignatureGuard` para hashear el cuerpo EXACTO tal
  // como lo firmó el navegador (kdevs-admin), sin re-serializar. No altera el
  // parsing normal del body.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });

  // Logger estructurado (Pino) reemplaza al logger nativo de Nest.
  app.useLogger(app.get(Logger));

  // Adapter Socket.IO. Lo registramos explícitamente para garantizar que el
  // servidor WebSocket se adjunta al MISMO servidor HTTP/puerto que la API
  // (3010), sin abrir un puerto aparte. El CORS del handshake lo define cada
  // `@WebSocketGateway` (RealtimeGateway: origin reflejado, sin credenciales),
  // independiente del CORS HTTP de Express configurado más abajo.
  app.useWebSocketAdapter(new IoAdapter(app));

  const configService = app.get(ConfigService);
  const appConfig = configService.getOrThrow<AppConfig>('app');

  // Seguridad HTTP headers.
  app.use(helmet());

  // CORS.
  //   - Producción/staging: SOLO la whitelist `CORS_ORIGINS` (estricto).
  //   - Desarrollo: además de la whitelist, se aceptan automáticamente
  //     localhost y cualquier IP de red privada (LAN) en cualquier puerto, para
  //     poder probar la PWA desde el navegador local o desde el celular
  //     (`http://192.168.x.x:5180`) sin tocar config en cada cambio de IP/puerto.
  const isProdLikeEnv =
    appConfig.nodeEnv === 'production' || appConfig.nodeEnv === 'staging';
  // localhost / 127.0.0.1 / [::1] y rangos privados 10.x, 172.16–31.x, 192.168.x.
  const privateLanOriginRe =
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})(:\d+)?$/;

  app.enableCors({
    origin: (origin, callback) => {
      // Requests sin header Origin (curl, apps nativas, same-origin): pasan.
      if (!origin) {
        callback(null, true);
        return;
      }
      if (appConfig.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      if (!isProdLikeEnv && privateLanOriginRe.test(origin)) {
        callback(null, true);
        return;
      }
      // Dev sin whitelist configurada: reflejar todo (comportamiento previo).
      if (!isProdLikeEnv && appConfig.corsOrigins.length === 0) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // `ngrok-skip-browser-warning` lo envía el cliente PWA cuando el API se
    // expone por un túnel ngrok en dev (salta la interstitial de ngrok). Sin
    // él en la whitelist, el preflight del navegador falla con "Error de CORS".
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'ngrok-skip-browser-warning',
    ],
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
