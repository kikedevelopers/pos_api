import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

/**
 * `sales_agent_follow_ups` — saludos de SEGUIMIENTO que el agente redactó y una
 * persona envió a un cliente por WhatsApp (QR). Ver la migración
 * `1747013150000` para el porqué de cada columna.
 */
@Entity('sales_agent_follow_ups')
@Index('idx_sales_agent_follow_ups_customer', ['company_id', 'customer_id', 'created_at'])
export class SalesAgentFollowUpEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'bigint', nullable: false })
  customer_id!: string;

  /** Canal por el que salió (`whatsapp-web` = WhatsApp por QR del escritorio). */
  @Column({ type: 'varchar', length: 16, default: 'whatsapp-web' })
  channel!: string;

  /** JID al que se envió (tal cual lo resolvió WhatsApp). */
  @Column({ type: 'text' })
  chat_id!: string;

  /** Número del cliente, solo dígitos con indicativo. */
  @Column({ type: 'varchar', length: 20 })
  phone!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'bigint', array: true, default: () => "'{}'" })
  recalled_product_ids!: string[];

  @Column({ type: 'bigint', array: true, default: () => "'{}'" })
  suggested_product_ids!: string[];

  @Column({ type: 'bigint', nullable: true })
  sent_by_user_id!: string | null;

  @Column({ type: 'text', nullable: true })
  sent_by_name!: string | null;

  /** Cuándo se inyectó en la conversación del agente (al responder el cliente). */
  @Column({ type: 'timestamptz', nullable: true })
  context_attached_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
