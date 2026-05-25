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
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
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
import { BackupModule } from './modules/backup/backup.module';
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
import { EmployeesModule } from './modules/employees/employees.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { FinancialMovementsModule } from './modules/financial-movements/financial-movements.module';
import { FixedExpensesModule } from './modules/fixed-expenses/fixed-expenses.module';
import { MigrationImportModule } from './modules/migration-import/migration-import.module';
import { PackagingsModule } from './modules/packagings/packagings.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PosDataModule } from './modules/pos-data/pos-data.module';
import { PosReportsModule } from './modules/pos-reports/pos-reports.module';
import { ProductHistoryModule } from './modules/product-history/product-history.module';
import { ProductsModule } from './modules/products/products.module';
import { PurchasesModule } from './modules/purchases/purchases.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SalesModule } from './modules/sales/sales.module';
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

    // Módulos de dominio — Fase 0 a Fase 5.
    // Orden: dependencias antes que dependientes. `AuthModule` va último
    // porque importa `WalletsModule` para el seed de la wallet "Efectivo"
    // dentro del registro.
    CompaniesModule,
    UsersModule,
    EmployeesModule,
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
    BanksModule,
    WalletsModule,
    CashRegisterModule,
    // Fase 2A — Fuentes de efectivo (wallets + banks + caja del usuario).
    CashSourcesModule,
    AccountsModule,
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
    // Fase 12 — Backup stub (paridad de contrato; siempre 503).
    BackupModule,
    // Migración cloud (altivopos Mongo → pos_api). Protegido por firma
    // asimétrica (`AdminSignatureGuard`), por lo que se monta en todos los
    // entornos. Lo consume el panel kdevs-admin (genera el ZIP y lo sube
    // firmado). El generador de ZIP vive ahora en kdevs-admin.
    MigrationImportModule,
    // Auth al final (depende de Wallets/TicketSettings/AppSettings para
    // sembrar valores iniciales al crear una company).
    AuthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Orden de evaluación de guards: NestJS los ejecuta en el orden en que
    // aparecen aquí. Primero JWT (poblar request.user), luego Roles (decidir
    // si el rol matchea), finalmente Throttler (rate limit).
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
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
