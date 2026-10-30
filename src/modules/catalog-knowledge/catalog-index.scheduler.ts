import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { SalesAgentAccessService } from '@/modules/sales-agent-access/sales-agent-access.service';

import { CatalogSemanticService } from './catalog-semantic.service';

/** Cada cuánto se revisa qué familias del catálogo hay que (re)indexar. */
export const CATALOG_INDEX_INTERVAL_MS = 60 * 1000;

/**
 * Textos que se mandan a indexar como máximo por corrida (por minuto), entre
 * TODOS los negocios. La cuota gratuita de Gemini es de 100 textos/minuto y la
 * comparten las búsquedas de los clientes: se deja margen para ellas.
 */
export const INDEX_TEXTS_PER_RUN = 60;

/**
 * Mantiene al día los vectores de significado del catálogo de los negocios que
 * tienen el asistente de ventas HABILITADO (panel superadmin). Incremental: solo recalcula lo que
 * cambió (producto nuevo, nombre, presentaciones o ficha), así que una corrida
 * sin cambios no gasta IA. Nunca lanza.
 *
 * Con varias instancias del API cada una indexaría lo mismo: es idempotente
 * (UPSERT por producto), el peor caso es pedir dos veces el mismo vector.
 */
@Injectable()
export class CatalogIndexScheduler {
  private readonly logger = new Logger(CatalogIndexScheduler.name);
  private running = false;

  constructor(
    private readonly access: SalesAgentAccessService,
    private readonly semantic: CatalogSemanticService,
  ) {}

  @Interval('catalog-index', CATALOG_INDEX_INTERVAL_MS)
  async handleInterval(): Promise<void> {
    await this.run();
  }

  async run(): Promise<void> {
    if (this.running || !this.semantic.isEnabled()) {
      return;
    }
    this.running = true;
    try {
      // Solo negocios con el asistente habilitado: los demás no gastan IA.
      const companies = await this.access.enabledCompanyIds();
      let budget = INDEX_TEXTS_PER_RUN;
      for (const company_id of companies) {
        if (budget <= 0) {
          break;
        }
        try {
          const result = await this.semantic.indexCompany(Number(company_id), budget);
          budget -= result.indexed;
          // Google rechazó (cuota u otro fallo): se sigue en la próxima corrida.
          if (result.indexed === 0 && result.pending > 0) {
            break;
          }
          if (result.indexed > 0) {
            this.logger.log(
              { companyId: Number(company_id), ...result },
              'Catálogo indexado para búsqueda por significado',
            );
          }
        } catch (error) {
          this.logger.error(
            { err: error, companyId: Number(company_id) },
            'Fallo indexando el catálogo del negocio',
          );
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Fallo en la indexación del catálogo');
    } finally {
      this.running = false;
    }
  }
}
