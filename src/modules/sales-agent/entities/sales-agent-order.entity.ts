import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';
import { Company } from '@/modules/companies/entities/company.entity';

import type { DeliveryMode } from '../internal/cart';

export const SALES_AGENT_ORDER_STATUSES = ['pending', 'taken', 'dismissed'] as const;

/** `pending` = por tomar; `taken` = el negocio lo tomó; `dismissed` = descartado. */
export type SalesAgentOrderStatus = (typeof SALES_AGENT_ORDER_STATUSES)[number];

/** Una línea del pedido, congelada al cerrar (precio del servidor). */
export interface SalesAgentOrderItem {
  product_id: number;
  /** Nombre EXACTO del catálogo al cerrar. */
  name: string;
  /** 4 decimales. */
  quantity: string;
  /** 2 decimales. */
  unit_price: string;
  /** 2 decimales. */
  total: string;
}

/**
 * `sales_agent_orders` — pedidos que cerró el agente de ventas en un chat. Es la
 * bandeja del informe "Agente": NO es una venta ni un ORDER del POS.
 */
@Entity('sales_agent_orders')
@Index('idx_sales_agent_orders_operation_unique', ['company_id', 'operation_id'], {
  unique: true,
})
export class SalesAgentOrderEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Identificador del carrito cerrado (idempotencia del cierre). */
  @Column({ type: 'uuid' })
  operation_id!: string;

  /** Referencia que vio el cliente ("P-4F2A9C1B"). */
  @Column({ type: 'varchar', length: 16 })
  reference!: string;

  @Column({
    type: 'enum',
    enum: SALES_AGENT_ORDER_STATUSES,
    enumName: 'sales_agent_order_status',
    default: 'pending',
  })
  status!: SalesAgentOrderStatus;

  /** Canal de la conversación (`telegram`, `whatsapp`, `whatsapp-web`). */
  @Column({ type: 'varchar', length: 32 })
  channel!: string;

  /** Cuenta del negocio que atendió (`@usuario_bot`, número de WhatsApp). */
  @Column({ type: 'varchar', length: 120, nullable: true })
  channel_account!: string | null;

  @Column({ type: 'text' })
  chat_id!: string;

  /** Nombre del cliente en el canal (perfil de WhatsApp/Telegram). */
  @Column({ type: 'varchar', length: 120, nullable: true })
  chat_display_name!: string | null;

  /** Número del cliente según el canal (WhatsApp); `null` si el canal no lo da. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  chat_phone!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  customer_name!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  customer_phone!: string | null;

  @Column({ type: 'varchar', length: 20 })
  delivery_mode!: DeliveryMode;

  @Column({ type: 'varchar', length: 250, nullable: true })
  delivery_address!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  payment_method!: string | null;

  @Column({ type: 'varchar', length: 250, nullable: true })
  notes!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  items!: SalesAgentOrderItem[];

  @Column({ type: 'integer', default: 0 })
  items_count!: number;

  @Column({ type: 'numeric', precision: 14, scale: 2, transformer: NumericTransformer })
  total!: number;

  /** Nota al cambiar de estado (p. ej. por qué se descartó). */
  @Column({ type: 'varchar', length: 250, nullable: true })
  status_note!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  status_changed_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  status_changed_by_user_id!: string | null;

  /** Ticket del POS donde se registró (PED-x → VTA-x). `null` = aún no. */
  @Column({ type: 'bigint', nullable: true })
  sale_invoice_id!: string | null;

  /** Última vez que el CLIENTE modificó el pedido (antes de que lo tomaran). */
  @Column({ type: 'timestamptz', nullable: true })
  customer_updated_at!: Date | null;

  /** Lo descartó el cliente (no el negocio). */
  @Column({ type: 'boolean', default: false })
  cancelled_by_customer!: boolean;

  /** Solicitud del cliente sobre el pedido YA tomado (cambiar o cancelar). */
  @Column({ type: 'varchar', length: 500, nullable: true })
  customer_request!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  customer_request_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
