import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  SALES_BOT_PERSONALITIES,
  isSalesBotPersonality,
  type SalesBotPersonality,
} from './entities/sales-bot-config.entity';
import {
  SALES_BOT_STOCK_POLICIES,
  SalesBotSettingsEntity,
  isSalesBotStockPolicy,
  type SalesBotStockPolicy,
} from './entities/sales-bot-settings.entity';

/** Ajustes del agente que ve y edita el dueño (iguales en todos los canales). */
export interface SalesBotSettings {
  /** Nombre con el que se presenta. Vacío = el nombre por defecto del agente. */
  bot_name: string;
  personality: SalesBotPersonality;
  stock_policy: SalesBotStockPolicy;
}

/**
 * Cambios a guardar. Los campos omitidos conservan su valor (clientes viejos
 * solo envían `stock_policy`).
 */
export type UpdateSalesBotSettingsInput = Partial<SalesBotSettings>;

export const DEFAULT_SALES_BOT_SETTINGS: SalesBotSettings = {
  bot_name: '',
  personality: SALES_BOT_PERSONALITIES.AMABLE_PROFESIONAL,
  stock_policy: SALES_BOT_STOCK_POLICIES.INFORM,
};

export const MAX_SALES_BOT_NAME_LEN = 60;

/**
 * Ajustes del agente por negocio (aplican a todos los canales). Si el negocio
 * no tiene fila, rigen los defaults.
 */
@Injectable()
export class SalesBotSettingsService {
  constructor(
    @InjectRepository(SalesBotSettingsEntity)
    private readonly repo: Repository<SalesBotSettingsEntity>,
  ) {}

  async get(companyId: number): Promise<SalesBotSettings> {
    const entity = await this.repo.findOne({ where: { company_id: String(companyId) } });
    return toSettings(entity);
  }

  async update(companyId: number, input: UpdateSalesBotSettingsInput): Promise<SalesBotSettings> {
    const botName = input.bot_name === undefined ? undefined : input.bot_name.trim();
    if (botName !== undefined && botName.length > MAX_SALES_BOT_NAME_LEN) {
      throw new BadRequestException(
        `El nombre del asistente no puede superar ${MAX_SALES_BOT_NAME_LEN} caracteres.`,
      );
    }
    if (input.personality !== undefined && !isSalesBotPersonality(input.personality)) {
      throw new BadRequestException('Personalidad del asistente no válida.');
    }
    if (input.stock_policy !== undefined && !isSalesBotStockPolicy(input.stock_policy)) {
      throw new BadRequestException('Política de stock no válida.');
    }

    const existing = await this.repo.findOne({ where: { company_id: String(companyId) } });
    const entity = existing ?? this.repo.create({ company_id: String(companyId) });
    if (botName !== undefined) {
      entity.bot_name = botName;
    }
    if (input.personality !== undefined) {
      entity.personality = input.personality;
    }
    if (input.stock_policy !== undefined) {
      entity.stock_policy = input.stock_policy;
    }
    const saved = await this.repo.save(entity);
    return toSettings(saved);
  }
}

const toSettings = (entity: SalesBotSettingsEntity | null): SalesBotSettings => ({
  bot_name: entity?.bot_name?.trim() ?? DEFAULT_SALES_BOT_SETTINGS.bot_name,
  personality: isSalesBotPersonality(entity?.personality)
    ? entity.personality
    : DEFAULT_SALES_BOT_SETTINGS.personality,
  stock_policy: isSalesBotStockPolicy(entity?.stock_policy)
    ? entity.stock_policy
    : DEFAULT_SALES_BOT_SETTINGS.stock_policy,
});
