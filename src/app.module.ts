import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ActiveCompanyGuard } from './common/guards/active-company.guard';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ResponseWrapperInterceptor } from './common/interceptors/response-wrapper.interceptor';
import { configurationLoaders } from './config/configuration';
import type { AppConfig } from './config/configuration';
import { validationSchema } from './config/validation.schema';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { AlertConfigsModule } from './modules/alert-configs/alert-configs.module';
import { AppAlertsModule } from './modules/app-alerts/app-alerts.module';
import { AppSettingsModule } from './modules/app-settings/app-settings.module';
import { AuthModule } from './modules/auth/auth.module';
import { AgreementsModule } from './modules/agreements/agreements.module';
import { AiModule } from './modules/ai/ai.module';
import { BackupModule } from './modules/backup/backup.module';
import { BackupRestoreModule } from './modules/backup-restore/backup-restore.module';
import { BanksModule } from './modules/banks/banks.module';
import { CarrierPaymentsModule } from './modules/carrier-payments/carrier-payments.module';
import { CarriersModule } from './modules/carriers/carriers.module';
import { CashRegisterModule } from './modules/cash-register/cash-register.module';
import { CashSourcesModule } from './modules/cash-sources/cash-sources.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { CreditNotesModule } from './modules/credit-notes/credit-notes.module';
import { CreditsModule } from './modules/credits/credits.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DeliveriesModule } from './modules/deliveries/deliveries.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { FinancialMovementsModule } from './modules/financial-movements/financial-movements.module';
import { TreasuryModule } from './modules/treasury/treasury.module';
import { FixedExpensesModule } from './modules/fixed-expenses/fixed-expenses.module';
import { MailModule } from './modules/mail/mail.module';
import { MigrationImportModule } from './modules/migration-import/migration-import.module';
import { PackagingsModule } from './modules/packagings/packagings.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PosDataModule } from './modules/pos-data/pos-data.module';
import { PosReportsModule } from './modules/pos-reports/pos-reports.module';
import { ProductHistoryModule } from './modules/product-history/product-history.module';
import { PortalModule } from './modules/portal/portal.module';
import { PortalScopeGuard } from './modules/portal/portal-scope.guard';
import { ProductsModule } from './modules/products/products.module';
import { PurchasesModule } from './modules/purchases/purchases.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { ReportsModule } from './modules/reports/reports.module';
import { RolesModule } from './modules/roles/roles.module';
import { SalesModule } from './modules/sales/sales.module';
import { SubscriptionGuard } from './modules/subscriptions/subscription.guard';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { BackupsModule } from './modules/backups/backups.module';
import { SuperadminModule } from './modules/superadmin/superadmin.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { TicketSettingsModule } from './modules/ticket-settings/ticket-settings.module';
import { UsersModule } from './modules/users/users.module';
import { WalletsModule } from './modules/wallets/wallets.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: configurationLoaders,
      validationSchema,
      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
      cache: true,
    }),

    // Logger estructurado con Pino. Pretty-print en development, JSON en otros entornos.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const app = configService.getOrThrow<AppConfig>('app');
        const isDev = app.nodeEnv === 'development';

        return {
          pinoHttp: {
            level: app.logLevel,
            // Genera un request-id por petición si el cliente no lo envía.
            genReqId: (req: IncomingMessage): string => {
              const headerId = req.headers['x-request-id'];
              if (typeof headerId === 'string' && headerId.length > 0) {
                return headerId;
              }
              return randomUUID();
            },
            customProps: (req: IncomingMessage): Record<string, unknown> => ({
              requestId: (req as IncomingMessage & { id?: string }).id,
            }),
            transport: isDev
              ? {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    colorize: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname,req,res,responseTime',
                    messageFormat: '[{context}] {msg}',
                  },
                }
              : undefined,
            // Redacta cabeceras y campos sensibles del cuerpo/respuesta.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.user.password',
                'res.headers["set-cookie"]',
                '*.access_token',
                '*.password',
              ],
              remove: true,
            },
            serializers: {
              req: (req: IncomingMessage & { id?: string; method?: string; url?: string }) => ({
                id: req.id,
                method: req.method,
                url: req.url,
              }),
              res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
            },
          },
        };
      },
    }),

    // Rate limiting global. La configuración se toma de env.
    //
    // `getTracker` resuelve qué string usar como bucket key. Por defecto usa
    // `req.ip`, pero detrás de un LB con `trust proxy` activo eso ya devuelve
    // la IP real. Aquí preferimos `req.ips[0]` (primer IP de X-Forwarded-For)
    // cuando exista para ser explícitos y blindarnos frente a cambios futuros
    // en la resolución de Express.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const app = configService.getOrThrow<AppConfig>('app');
        return {
          throttlers: [
            {
              ttl: app.throttle.ttl,
              limit: app.throttle.limit,
            },
          ],
          getTracker: (req: Record<string, unknown>): string => {
            const ips = req.ips as string[] | undefined;
            if (ips && ips.length > 0 && typeof ips[0] === 'string') {
              return ips[0];
            }
            const ip = req.ip as string | undefined;
            return ip ?? 'unknown';
          },
        };
      },
    }),

    DatabaseModule,
    HealthModule,

    // Correo saliente. `@Global`: cualquier módulo puede inyectar `MailService`
    // sin importarlo. Va temprano porque es infraestructura, no dominio, y
    // porque los módulos de dominio que envíen correos deben encontrarlo listo.
    MailModule,

    // Módulos de dominio — Fase 0 a Fase 5.
    // Orden: dependencias antes que dependientes. `AuthModule` va último
    // porque importa `WalletsModule` para el seed de la wallet "Efectivo"
    // dentro del registro.
    CompaniesModule,
    UsersModule,
    EmployeesModule,
    // FASE 2 — Roles y permisos (CRUD /roles + resolución de permisos
    // efectivos para el perfil). Va antes de AuthModule, que lo importa para
    // exponer `permissions` en GET /auth/profile.
    RolesModule,
    // Fase 3 — Catálogo.
    PackagingsModule,
    // Fase 2A — Categorías (debe declararse antes de ProductsModule para que
    // la FK products.category_id apunte a una tabla ya migrada; en runtime
    // Nest no impone orden, pero conservamos coherencia conceptual).
    CategoriesModule,
    ProductsModule,
    // Fase 2A — Historial de costo/precio de productos (rutas absolutas
    // /products/:id/cost-history y /product-prices/:id/price-history).
    ProductHistoryModule,
    // Fase 4 — Personas externas.
    CustomersModule,
    SuppliersModule,
    // Fase 2A — Transportistas (carriers + carrier-credits + analytics).
    CarriersModule,
    // Fase 5 — Cuentas y caja.
    FinancialMovementsModule,
    TreasuryModule,
    AgreementsModule,
    BanksModule,
    WalletsModule,
    CashRegisterModule,
    // Fase 2A — Fuentes de efectivo (wallets + banks + caja del usuario).
    CashSourcesModule,
    AccountsModule,
    // Tiempo real (Socket.IO) — gateway `ticket:changed`. Reusa el mismo
    // servidor HTTP/puerto que la API. SalesModule lo importa para emitir al
    // crear venta; se declara aquí para activar el IoAdapter por defecto.
    RealtimeModule,
    // Fase 6 — Ventas.
    SalesModule,
    // Fase 7 — Notas crédito/débito (depende de Sales).
    CreditNotesModule,
    // Fase 8 — Compras.
    PurchasesModule,
    // Fase 2A — Pagos a transportistas (depende de Carriers + Purchases +
    // Banks/Wallets/CashRegister/FinancialMovements).
    CarrierPaymentsModule,
    // Fase 9 — Gastos y agregadores (credits/payments dependen de Sales+Purchases).
    ExpensesModule,
    // Módulo Domiciliarios — domiciliarios + domicilios. Depende de
    // CashRegister (egreso de caja) y Sales (prefill / venta ligada).
    DeliveriesModule,
    // Ola 2B — Gastos fijos (catálogo + cortes vencidos). Depende
    // conceptualmente de `companies` y `app_alerts` (FK opcional).
    FixedExpensesModule,
    CreditsModule,
    PaymentsModule,
    // Fase 10 — Settings y alertas.
    // TicketSettingsModule y AppSettingsModule se exportan para que el seed
    // en RegisterAction (vía AuthModule) los pueda inyectar.
    TicketSettingsModule,
    AppSettingsModule,
    AppAlertsModule,
    AlertConfigsModule,
    // Fase 11 — Reportes y dashboard. Read-only sobre tablas de fases previas.
    DashboardModule,
    ReportsModule,
    PosReportsModule,
    PosDataModule,
    // PlacePOS IA — chat con Gemini + herramientas de solo lectura sobre la
    // base del tenant. Cloud-only: no tiene gemelo en el Express de placepos.
    AiModule,
    // Fase 12 — Backup stub (paridad de contrato; siempre 503).
    BackupModule,
    // Migración cloud (altivopos Mongo → pos_api). Protegido por firma
    // asimétrica (`AdminSignatureGuard`), por lo que se monta en todos los
    // entornos. Lo consume el panel kdevs-admin (genera el ZIP y lo sube
    // firmado). El generador de ZIP vive ahora en kdevs-admin.
    MigrationImportModule,
    // Panel superadmin (kdevs-admin). Endpoints `/superadmin/*` protegidos por
    // firma asimétrica DEDICADA (`SUPERADMIN_SIGNING_PUBLIC_KEY`). Cross-tenant:
    // listar/ver/ajustar-suscripción/borrar tenants. Importa UsersModule para
    // reutilizar `ListOwnersAction`.
    SuperadminModule,
    BackupsModule,
    // Restore de backup NATIVO de placepos para el owner autenticado
    // (`POST /backup/restore`). Reutiliza `ImportZipAction` de
    // MigrationImportModule. Protegido por JWT + @Roles('owner') + Subscription.
    BackupRestoreModule,
    // Suscripciones (cloud-only). Se importa aquí para que el guard global
    // `SubscriptionGuard` (APP_GUARD) y `SubscriptionsService` resuelvan. Va
    // antes de AuthModule porque AuthModule lo importa para el seed y el
    // bloqueo de login.
    SubscriptionsModule,
    // Auth al final (depende de Wallets/TicketSettings/AppSettings/Subscriptions
    // para sembrar valores iniciales al crear una company).
    AuthModule,
    // Portal de facturación de la landing. Después de AuthModule porque lo
    // importa (reutiliza su emisor de JWT y su hash dummy).
    PortalModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Orden de evaluación de guards: NestJS los ejecuta en el orden en que
    // aparecen aquí. Primero JWT (poblar request.user), luego Subscription
    // (bloqueo 402 si la suscripción de la company venció — necesita
    // request.user ya poblado), luego Roles (decidir si el rol matchea),
    // finalmente Throttler (rate limit).
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Alcance del token: un JWT del portal de facturación solo vale en
    // `/portal/*`. Va ANTES de SubscriptionGuard para que usarlo fuera de su
    // sitio responda 403 (alcance) y no 402 (suscripción) — que es el motivo
    // real y el que hay que decirle al cliente.
    {
      provide: APP_GUARD,
      useClass: PortalScopeGuard,
    },
    {
      provide: APP_GUARD,
      useClass: SubscriptionGuard,
    },
    // Multi-sucursal: bloquea peticiones de negocio cuyo company_id (JWT) sea
    // una sucursal suspendida o sin permiso. Tras SubscriptionGuard, antes de
    // Roles. Exime /auth/* y /branches/* (@SkipActiveCompanyCheck).
    {
      provide: APP_GUARD,
      useClass: ActiveCompanyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // Enforcement de permisos de módulo (FASE 4). Tras RolesGuard: el gating
    // grueso por `UserType` corre primero; este refina por permiso granular en
    // los endpoints decorados con `@RequirePermission`. Solo consulta la BD
    // cuando el endpoint está decorado y el actor es un empleado.
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Wrapper de respuesta global (contrato PlacePos: { success, payload }).
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseWrapperInterceptor,
    },
    // Filtro global de errores. Se mantiene aquí porque `main.ts` no lo
    // registra; el `ValidationPipe` sí está en `main.ts` (decisión: el pipe
    // necesita `transform/transformOptions` que se afinan junto al bootstrap).
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
