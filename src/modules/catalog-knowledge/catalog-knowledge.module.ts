import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GeminiClient } from '@/modules/ai/internal/gemini-client';
import { RolesModule } from '@/modules/roles/roles.module';
import { SalesAgentAccessModule } from '@/modules/sales-agent-access/sales-agent-access.module';

import { CatalogIndexScheduler } from './catalog-index.scheduler';
import { CatalogKnowledgeController } from './catalog-knowledge.controller';
import { CatalogSemanticService } from './catalog-semantic.service';
import { ProductAssistantProfileEntity } from './entities/product-assistant-profile.entity';
import { ProductSearchEmbeddingEntity } from './entities/product-search-embedding.entity';
import { GeminiEmbeddingsClient } from './internal/gemini-embeddings.client';
import { ProductAssistantProfileService } from './product-assistant-profile.service';
import { SuggestAssistantProfileAction } from './suggest-assistant-profile.action';

/**
 * Conocimiento del catálogo para el asistente de ventas: ficha "Para el
 * asistente" por producto, "Completar con IA" y búsqueda por significado
 * (embeddings de Gemini, indexación incremental).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ProductAssistantProfileEntity, ProductSearchEmbeddingEntity]),
    RolesModule,
    SalesAgentAccessModule,
  ],
  controllers: [CatalogKnowledgeController],
  providers: [
    ProductAssistantProfileService,
    CatalogSemanticService,
    CatalogIndexScheduler,
    SuggestAssistantProfileAction,
    GeminiEmbeddingsClient,
    GeminiClient,
  ],
  exports: [CatalogSemanticService],
})
export class CatalogKnowledgeModule {}
