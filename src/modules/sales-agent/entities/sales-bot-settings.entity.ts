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
 * Formas de pago que el negocio acepta y que el agente puede ofrecer:
 *  - `cash`: efectivo (contra entrega o en el punto).
 *  - `bank_transfer`: transferencia o consignación bancaria.
 *  - `debit_card` / `credit_card`: tarjetas (datáfono o link de pago).
 */
export const SALES_BOT_PAYMENT_METHODS = {
  CASH: 'cash',
  BANK_TRANSFER: 'bank_transfer',
  DEBIT_CARD: 'debit_card',
  CREDIT_CARD: 'credit_card',
} as const;

export type SalesBotPaymentMethod =
  (typeof SALES_BOT_PAYMENT_METHODS)[keyof typeof SALES_BOT_PAYMENT_METHODS];

export const SALES_BOT_PAYMENT_METHOD_VALUES: readonly SalesBotPaymentMethod[] = [
  SALES_BOT_PAYMENT_METHODS.CASH,
  SALES_BOT_PAYMENT_METHODS.BANK_TRANSFER,
  SALES_BOT_PAYMENT_METHODS.DEBIT_CARD,
  SALES_BOT_PAYMENT_METHODS.CREDIT_CARD,
] as const;

export const isSalesBotPaymentMethod = (value: unknown): value is SalesBotPaymentMethod =>
  typeof value === 'string' &&
  (SALES_BOT_PAYMENT_METHOD_VALUES as readonly string[]).includes(value);

/** Lo que el agente ofrecía antes de que el dueño pudiera elegir. */
export const DEFAULT_SALES_BOT_PAYMENT_METHODS: readonly SalesBotPaymentMethod[] = [
  SALES_BOT_PAYMENT_METHODS.CASH,
  SALES_BOT_PAYMENT_METHODS.BANK_TRANSFER,
];

/** Largo máximo de cada indicación de estilo del dueño (saludo, venta, cierre). */
/** Cómo entrega el negocio: `pickup` = recogen en el negocio; `delivery` = domicilio. */
export const SALES_BOT_DELIVERY_MODES = {
  PICKUP: 'pickup',
  DELIVERY: 'delivery',
} as const;

export type SalesBotDeliveryMode =
  (typeof SALES_BOT_DELIVERY_MODES)[keyof typeof SALES_BOT_DELIVERY_MODES];

export const SALES_BOT_DELIVERY_MODE_VALUES: readonly SalesBotDeliveryMode[] = [
  SALES_BOT_DELIVERY_MODES.PICKUP,
  SALES_BOT_DELIVERY_MODES.DELIVERY,
] as const;

export const isSalesBotDeliveryMode = (value: unknown): value is SalesBotDeliveryMode =>
  typeof value === 'string' &&
  (SALES_BOT_DELIVERY_MODE_VALUES as readonly string[]).includes(value);

export const DEFAULT_SALES_BOT_DELIVERY_MODES: readonly SalesBotDeliveryMode[] = [
  SALES_BOT_DELIVERY_MODES.PICKUP,
  SALES_BOT_DELIVERY_MODES.DELIVERY,
];

export const MAX_SALES_BOT_PICKUP_ADDRESS_LEN = 250;

/** Mensajes fuera de tema antes de que el agente se despida (0 = filtro apagado). */
export const DEFAULT_SALES_BOT_OFF_TOPIC_LIMIT = 3;
export const MAX_SALES_BOT_OFF_TOPIC_LIMIT = 10;

export const MAX_SALES_BOT_STYLE_LEN = 500;

/** Largo máximo de las indicaciones de pago (cuentas, datáfono, etc.). */
export const MAX_SALES_BOT_PAYMENT_INSTRUCTIONS_LEN = 300;

/**
 * `sales_bot_settings` — ajustes de comportamiento del agente por negocio.
 * Aplican a todos los canales (Telegram, WhatsApp): persona (nombre +
 * personalidad + estilo propio), formas de pago y política de stock. Una fila
 * por negocio; si no existe, rigen los defaults.
 */
@Entity('sales_bot_settings')
@Index('idx_sales_bot_settings_company_unique', ['company_id'], { unique: true })
@Check('chk_sales_bot_settings_stock_policy', `"stock_policy" IN ('inform', 'offer_always')`)
@Check('chk_sales_bot_settings_bot_name_len', 'length(bot_name) <= 60')
@Check(
  'chk_sales_bot_settings_payment_methods',
  `cardinality("payment_methods") >= 1 AND "payment_methods" <@ ARRAY['cash', 'bank_transfer', 'debit_card', 'credit_card']::text[]`,
)
@Check(
  'chk_sales_bot_settings_style_len',
  'length(greeting_style) <= 500 AND length(selling_style) <= 500 AND length(closing_style) <= 500',
)
@Check('chk_sales_bot_settings_payment_instructions_len', 'length(payment_instructions) <= 300')
@Check(
  'chk_sales_bot_settings_delivery_modes',
  `cardinality("delivery_modes") >= 1 AND "delivery_modes" <@ ARRAY['pickup', 'delivery']::text[]`,
)
@Check('chk_sales_bot_settings_pickup_address_len', 'length("pickup_address") <= 250')
@Check('chk_sales_bot_settings_off_topic_limit', '"off_topic_limit" BETWEEN 0 AND 10')
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

  /** Cómo quiere el dueño que salude (texto libre). Vacío = el tono del preset. */
  @Column({ type: 'text', default: '' })
  greeting_style!: string;

  /** Cómo quiere el dueño que asesore y aborde la venta. */
  @Column({ type: 'text', default: '' })
  selling_style!: string;

  /** Cómo quiere el dueño que cierre la venta. */
  @Column({ type: 'text', default: '' })
  closing_style!: string;

  /** Formas de pago que acepta el negocio (al menos una). */
  @Column({ type: 'text', array: true, default: () => `'{cash,bank_transfer}'` })
  payment_methods!: SalesBotPaymentMethod[];

  /** Indicaciones de pago que el agente comparte (cuentas, datáfono...). */
  @Column({ type: 'text', default: '' })
  payment_instructions!: string;

  /** Entregas que ofrece el negocio (al menos una). */
  @Column({ type: 'text', array: true, default: () => `'{pickup,delivery}'` })
  delivery_modes!: SalesBotDeliveryMode[];

  /** Dónde se recoge. Vacío = la dirección del negocio (`companies.address`). */
  @Column({ type: 'text', default: '' })
  pickup_address!: string;

  /** Mensajes fuera de tema antes de despedirse y callar (0 = filtro apagado). */
  @Column({ type: 'integer', default: DEFAULT_SALES_BOT_OFF_TOPIC_LIMIT })
  off_topic_limit!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
