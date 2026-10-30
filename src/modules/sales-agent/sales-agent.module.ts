import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GeminiClient } from '@/modules/ai/internal/gemini-client';
import { AdminLevelGuard } from '@/common/guards/admin-level.guard';
import { RolesModule } from '@/modules/roles/roles.module';

import { TelegramBotManager } from './channels/telegram/telegram-bot.manager';
import { WhatsappHandlerService } from './channels/whatsapp/whatsapp-handler.service';
import { WhatsappWebhookController } from './channels/whatsapp/whatsapp.controller';
import { SalesBotConfigEntity } from './entities/sales-bot-config.entity';
import { SellerSessionStore } from './internal/session-store';
import { SellerToolRunner } from './internal/seller-tool-runner';
import { SalesBotConfigService } from './sales-bot-config.service';
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
 * `sales_bot_configs` persiste la config por negocio; la memoria de conversación
 * sigue en memoria (`SellerSessionStore`) para esta fase.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SalesBotConfigEntity]), RolesModule],
  controllers: [SalesBotController, WhatsappWebhookController],
  providers: [
    SalesAgentService,
    SalesBotConfigService,
    SellerToolRunner,
    SellerSessionStore,
    TelegramBotManager,
    WhatsappHandlerService,
    AdminLevelGuard,
    // Instancia propia del cliente de Gemini (sin estado): se reutiliza la clase
    // del módulo `ai` sin importar todo ese módulo.
    GeminiClient,
  ],
  exports: [SalesAgentService, SalesBotConfigService],
})
export class SalesAgentModule {}
