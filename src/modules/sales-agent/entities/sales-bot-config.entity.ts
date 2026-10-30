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

/**
 * Canal por el que el vendedor Place atiende a los clientes del negocio.
 * Hoy solo `telegram` está activo; `whatsapp` queda reservado para la siguiente
 * fase (la UI lo muestra deshabilitado).
 */
export const SALES_BOT_CHANNELS = {
  TELEGRAM: 'telegram',
  WHATSAPP: 'whatsapp',
} as const;

export type SalesBotChannel = (typeof SALES_BOT_CHANNELS)[keyof typeof SALES_BOT_CHANNELS];

/**
 * Personalidad de venta del bot. Define el TONO con el que Place atiende; el
 * resto de reglas (no revelar costos, consultar inventario real, cerrar, etc.)
 * no cambian. Son tres presets cerrados para que el dueño elija sin redactar
 * prompts.
 */
export const SALES_BOT_PERSONALITIES = {
  /** Cálido, cercano y profesional (tono por defecto). */
  AMABLE_PROFESIONAL: 'amable_profesional',
  /** Conciso, al grano y orientado al cierre. */
  DIRECTO_COMERCIAL: 'directo_comercial',
  /** Registro formal, trato de "usted", tono corporativo. */
  FORMAL_CORPORATIVO: 'formal_corporativo',
} as const;

export type SalesBotPersonality =
  (typeof SALES_BOT_PERSONALITIES)[keyof typeof SALES_BOT_PERSONALITIES];

export const SALES_BOT_PERSONALITY_VALUES: readonly SalesBotPersonality[] = [
  SALES_BOT_PERSONALITIES.AMABLE_PROFESIONAL,
  SALES_BOT_PERSONALITIES.DIRECTO_COMERCIAL,
  SALES_BOT_PERSONALITIES.FORMAL_CORPORATIVO,
] as const;

export const isSalesBotPersonality = (value: unknown): value is SalesBotPersonality =>
  typeof value === 'string' &&
  (SALES_BOT_PERSONALITY_VALUES as readonly string[]).includes(value);

/**
 * `sales_bot_configs` — configuración del bot VENDEDOR por negocio y canal.
 *
 * Multi-tenant: una fila por `(company_id, channel)` (UNIQUE en la migración).
 * El dueño configura, por el menú "Asistente de ventas", el nombre con el que el
 * bot se presenta, su personalidad de venta y las credenciales del canal.
 *
 * SECRETO: `telegram_token` (el token de @BotFather) vive SOLO en el servidor,
 * igual que la llave de Gemini. El API NUNCA lo devuelve al cliente: la UI solo
 * ve `has_token` y el `@username` que reporta Telegram (getMe). El poller lo lee
 * de aquí para arrancar el bot del negocio.
 */
@Entity('sales_bot_configs')
@Index('idx_sales_bot_configs_company_channel_unique', ['company_id', 'channel'], { unique: true })
@Check('chk_sales_bot_configs_bot_name_len', 'length(bot_name) <= 60')
export class SalesBotConfigEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'varchar', length: 16, default: SALES_BOT_CHANNELS.TELEGRAM })
  channel!: SalesBotChannel;

  /** Apaga el bot sin borrar la config (el poller no lo arranca). */
  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  /** Nombre con el que el bot se presenta en el chat (ej. "Andrea"). Vacío = default. */
  @Column({ type: 'text', default: '' })
  bot_name!: string;

  @Column({
    type: 'enum',
    enum: SALES_BOT_PERSONALITY_VALUES,
    enumName: 'sales_bot_personality',
    default: SALES_BOT_PERSONALITIES.AMABLE_PROFESIONAL,
  })
  personality!: SalesBotPersonality;

  /** Token del bot de @BotFather. SECRETO: nunca sale del servidor. */
  @Column({ type: 'text', nullable: true })
  telegram_token!: string | null;

  /** @username del bot (getMe). Público, sí se muestra en la UI. */
  @Column({ type: 'text', nullable: true })
  telegram_bot_username!: string | null;

  /** id numérico del bot (getMe), para auditar/diagnosticar. */
  @Column({ type: 'bigint', nullable: true })
  telegram_bot_id!: string | null;

  /** Chat del dueño al que el bot avisa cada pedido cerrado. Vacío = solo log. */
  @Column({ type: 'text', nullable: true })
  owner_chat_id!: string | null;

  /**
   * WhatsApp (Cloud API) — solo aplica a filas con channel = 'whatsapp'.
   *   - `whatsapp_phone_number_id`: id del número (clave de ruteo del webhook).
   *   - `whatsapp_access_token`: token propio del negocio (SECRETO). NULL = usa
   *     el token compartido de la app.
   *   - `whatsapp_waba_id`: id de la WhatsApp Business Account (informativo).
   */
  @Column({ type: 'text', nullable: true })
  whatsapp_phone_number_id!: string | null;

  @Column({ type: 'text', nullable: true })
  whatsapp_access_token!: string | null;

  @Column({ type: 'text', nullable: true })
  whatsapp_waba_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
