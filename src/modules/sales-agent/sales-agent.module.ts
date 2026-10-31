import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GeminiClient } from '@/modules/ai/internal/gemini-client';
import { AdminLevelGuard } from '@/common/guards/admin-level.guard';
import { CatalogKnowledgeModule } from '@/modules/catalog-knowledge/catalog-knowledge.module';
import { SalesAgentAccessModule } from '@/modules/sales-agent-access/sales-agent-access.module';
import { RealtimeModule } from '@/modules/realtime/realtime.module';
import { RolesModule } from '@/modules/roles/roles.module';

import { TelegramBotManager } from './channels/telegram/telegram-bot.manager';
import { WhatsappHandlerService } from './channels/whatsapp/whatsapp-handler.service';
import { WhatsappWebhookController } from './channels/whatsapp/whatsapp.controller';
import { WhatsappWebRelayController } from './channels/whatsapp-web/whatsapp-web-relay.controller';
import { WhatsappWebRelayService } from './channels/whatsapp-web/whatsapp-web-relay.service';
import { SalesBotConfigEntity } from './entities/sales-bot-config.entity';
import { SalesAgentOrderEntity } from './entities/sales-agent-order.entity';
import { AppAlert } from '@/modules/app-alerts/entities/app-alert.entity';
import { SalesBotConversationEntity } from './entities/sales-bot-conversation.entity';
import { SalesBotSettingsEntity } from './entities/sales-bot-settings.entity';
import { SalesBotTakeoverEntity } from './entities/sales-bot-takeover.entity';
import { SalesAgentOrdersController } from './sales-agent-orders.controller';
import { SalesAgentOrdersService } from './sales-agent-orders.service';
import { SellerCartService } from './seller-cart.service';
import { SalesBotSettingsService } from './sales-bot-settings.service';
import { SalesBotTakeoverService } from './sales-bot-takeover.service';
import { SellerSessionStore } from './internal/session-store';
import { SellerToolRunner } from './internal/seller-tool-runner';
import { SalesBotConfigService } from './sales-bot-config.service';
import { SalesAgentAccessController } from './sales-agent-access.controller';
import { SalesBotController } from './sales-bot.controller';
import { SalesAgentService } from './seller-agent.service';

/**
 * Módulo `sales-agent` — Place como VENDEDOR en canales de chat.
 *
 * AISLADO del módulo `ai` (el asistente del dueño): persona, prompt, herramientas
 * y controlador propios. Solo comparte el `GeminiClient` (cliente HTTP sin estado
 * de Gemini) y helpers puros de inventario, para no reescribir el motor.
 *
 * Hoy habla por Telegram (long-polling). Es MULTI-TENANT: cada dueño configura su
 * bot (token, nombre, personalidad) desde el menú "Asistente de ventas" y el
 * `TelegramBotManager` levanta un worker por negocio. El cerebro
 * (`SalesAgentService`) es agnóstico del canal: cuando se sume WhatsApp, solo se
 * agrega otro adaptador en `channels/`.
 *
 * `sales_bot_configs` persiste la config por negocio y `sales_bot_conversations`
 * la memoria de conversación (`SellerSessionStore`), que sobrevive a reinicios.
 * `sales_agent_orders` guarda los pedidos que cierra el agente: la bandeja del
 * informe "Agente" (`SalesAgentOrdersService`), que se refresca en tiempo real.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SalesBotConfigEntity,
      SalesBotSettingsEntity,
      SalesBotTakeoverEntity,
      SalesBotConversationEntity,
      SalesAgentOrderEntity,
      AppAlert,
    ]),
    RolesModule,
    RealtimeModule,
    CatalogKnowledgeModule,
    SalesAgentAccessModule,
  ],
  controllers: [
    SalesBotController,
    SalesAgentAccessController,
    SalesAgentOrdersController,
    WhatsappWebhookController,
    WhatsappWebRelayController,
  ],
  providers: [
    SalesAgentService,
    SalesBotConfigService,
    SalesBotSettingsService,
    SalesBotTakeoverService,
    SellerToolRunner,
    SellerSessionStore,
    SellerCartService,
    SalesAgentOrdersService,
    TelegramBotManager,
    WhatsappHandlerService,
    WhatsappWebRelayService,
    AdminLevelGuard,
    // Instancia propia del cliente de Gemini (sin estado): se reutiliza la clase
    // del módulo `ai` sin importar todo ese módulo.
    GeminiClient,
  ],
  exports: [SalesAgentService, SalesBotConfigService, TelegramBotManager],
})
export class SalesAgentModule {}
