import { Module } from '@nestjs/common';

import { GeminiClient } from '@/modules/ai/internal/gemini-client';

import { TelegramPollerService } from './channels/telegram/telegram-poller.service';
import { SellerSessionStore } from './internal/session-store';
import { SellerToolRunner } from './internal/seller-tool-runner';
import { SalesAgentService } from './seller-agent.service';

/**
 * Módulo `sales-agent` — Place como VENDEDOR en canales de chat.
 *
 * AISLADO del módulo `ai` (el asistente del dueño): persona, prompt, herramientas
 * y controlador propios. Solo comparte el `GeminiClient` (cliente HTTP sin estado
 * de Gemini) y helpers puros de inventario, para no reescribir el motor.
 *
 * Hoy habla por Telegram (long-polling, `TelegramPollerService`). El cerebro
 * (`SalesAgentService`) es agnóstico del canal: cuando se sume WhatsApp, solo se
 * agrega otro adaptador en `channels/` que llame a `handleMessage`.
 *
 * No declara entidades: la memoria de conversación es en memoria
 * (`SellerSessionStore`) para esta v1. Consulta inventario con SQL plano vía el
 * `DataSource` global, acotado al negocio de `SALES_BOT_COMPANY_ID`.
 */
@Module({
  providers: [
    SalesAgentService,
    SellerToolRunner,
    SellerSessionStore,
    TelegramPollerService,
    // Instancia propia del cliente de Gemini (sin estado): se reutiliza la clase
    // del módulo `ai` sin importar todo ese módulo.
    GeminiClient,
  ],
  exports: [SalesAgentService],
})
export class SalesAgentModule {}
