import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountsModule } from '@/modules/accounts/accounts.module';
import { BanksModule } from '@/modules/banks/banks.module';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { Company } from '@/modules/companies/entities/company.entity';
import { DashboardModule } from '@/modules/dashboard/dashboard.module';
import { ExpensesModule } from '@/modules/expenses/expenses.module';
import { PosDataModule } from '@/modules/pos-data/pos-data.module';
import { PurchasesModule } from '@/modules/purchases/purchases.module';
import { RealtimeModule } from '@/modules/realtime/realtime.module';
import { RolesModule } from '@/modules/roles/roles.module';
import { SalesModule } from '@/modules/sales/sales.module';
import { TreasuryModule } from '@/modules/treasury/treasury.module';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { AiAttachmentsAction } from './actions/ai-attachments.action';
import { AiCreditsAction } from './actions/ai-credits.action';
import { GenerateAiGreetingAction } from './actions/generate-ai-greeting.action';
import { ResolveAiActorAction } from './actions/resolve-ai-actor.action';
import { RunAiExpenseToolAction } from './actions/run-ai-expense-tool.action';
import { RunAiPurchaseToolAction } from './actions/run-ai-purchase-tool.action';
import { RunAiSaleToolAction } from './actions/run-ai-sale-tool.action';
import { RunAiTreasuryToolAction } from './actions/run-ai-treasury-tool.action';
import { RunAiToolAction } from './actions/run-ai-tool.action';
import { StreamAiChatAction } from './actions/stream-ai-chat.action';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { GeminiClient } from './internal/gemini-client';
import { GeminiFilesClient } from './internal/gemini-files';

/**
 * Módulo `ai` — Place, el asistente del negocio (Google Gemini + herramientas
 * sobre la base del tenant: de lectura, y de gastos para administradores).
 *
 * Reutiliza la maquinaria financiera canónica en vez de recalcular métricas:
 * `DashboardModule` (resumen del día, rendimiento, top productos) y
 * `TreasuryModule` (saldos de todas las cajas). `RolesModule` aporta la
 * resolución de permisos efectivos, con la que se decide qué herramientas se le
 * ofrecen al modelo.
 *
 * `ExpensesModule` aporta `CreateExpenseAction`/`VoidExpenseAction`: las
 * herramientas de gastos escriben con la misma lógica que la app. `SalesModule`
 * aporta `CreateSaleAction` (los pedidos que prepara Place se crean igual que
 * con `POST /sales`) y `RealtimeModule` el aviso `ticket:changed` a los POS.
 * `AccountsModule`, `PosDataModule`, `BanksModule`, `WalletsModule` y
 * `CashRegisterModule` aportan "Mover saldo" y "Corregir caja": las
 * herramientas de tesorería mueven el dinero con la misma lógica que la app.
 * `PurchasesModule` aporta `CreatePurchaseAction`: las compras que Place arma
 * desde una factura adjunta se crean igual que con `POST /purchases`.
 *
 * No declara entidades: el historial del chat vive en el cliente. Sus tablas
 * propias se manejan con SQL plano: `ai_pending_actions` (gastos, pedidos,
 * movimientos de saldo y compras esperando el "sí" del usuario) y
 * `ai_attachments` (dueño de cada foto/PDF subido al Files API de Google).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Company]),
    DashboardModule,
    TreasuryModule,
    RolesModule,
    ExpensesModule,
    SalesModule,
    RealtimeModule,
    AccountsModule,
    PosDataModule,
    BanksModule,
    WalletsModule,
    CashRegisterModule,
    PurchasesModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    StreamAiChatAction,
    GenerateAiGreetingAction,
    RunAiToolAction,
    RunAiExpenseToolAction,
    RunAiSaleToolAction,
    RunAiTreasuryToolAction,
    RunAiPurchaseToolAction,
    ResolveAiActorAction,
    AiCreditsAction,
    AiAttachmentsAction,
    GeminiClient,
    GeminiFilesClient,
  ],
  // AiCreditsAction: el panel superadmin asigna créditos y lee el consumo.
  exports: [AiService, AiCreditsAction],
})
export class AiModule {}
