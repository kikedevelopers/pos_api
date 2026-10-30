import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

import {
  SALES_BOT_PERSONALITIES,
  SALES_BOT_PERSONALITY_VALUES,
  type SalesBotPersonality,
} from './sales-bot-config.entity';

/**
 * Qué hace el agente cuando un producto no tiene existencias:
 *  - `inform`: lo dice (da el precio y aclara que ahora no hay). Default.
 *  - `offer_always`: lo ofrece y lo vende normal, SIN mencionar el stock (la
 *    disponibilidad la gestiona el negocio). Al modelo ni le llega el stock.
 */
export const SALES_BOT_STOCK_POLICIES = {
  INFORM: 'inform',
  OFFER_ALWAYS: 'offer_always',
} as const;

export type SalesBotStockPolicy =
  (typeof SALES_BOT_STOCK_POLICIES)[keyof typeof SALES_BOT_STOCK_POLICIES];

export const SALES_BOT_STOCK_POLICY_VALUES: readonly SalesBotStockPolicy[] = [
  SALES_BOT_STOCK_POLICIES.INFORM,
  SALES_BOT_STOCK_POLICIES.OFFER_ALWAYS,
] as const;

export const isSalesBotStockPolicy = (value: unknown): value is SalesBotStockPolicy =>
  typeof value === 'string' && (SALES_BOT_STOCK_POLICY_VALUES as readonly string[]).includes(value);

/**
 * `sales_bot_settings` — ajustes de comportamiento del agente por negocio.
 * Aplican a todos los canales (Telegram, WhatsApp): persona (nombre +
 * personalidad) y política de stock. Una fila por negocio; si no
 * existe, rigen los defaults.
 */
@Entity('sales_bot_settings')
@Index('idx_sales_bot_settings_company_unique', ['company_id'], { unique: true })
@Check('chk_sales_bot_settings_stock_policy', `"stock_policy" IN ('inform', 'offer_always')`)
@Check('chk_sales_bot_settings_bot_name_len', 'length(bot_name) <= 60')
export class SalesBotSettingsEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Nombre con el que el agente se presenta en TODOS los canales. Vacío = default. */
  @Column({ type: 'text', default: '' })
  bot_name!: string;

  /** Personalidad de venta (tono), igual en todos los canales. */
  @Column({
    type: 'enum',
    enum: SALES_BOT_PERSONALITY_VALUES,
    enumName: 'sales_bot_personality',
    default: SALES_BOT_PERSONALITIES.AMABLE_PROFESIONAL,
  })
  personality!: SalesBotPersonality;

  @Column({ type: 'varchar', length: 32, default: SALES_BOT_STOCK_POLICIES.INFORM })
  stock_policy!: SalesBotStockPolicy;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
