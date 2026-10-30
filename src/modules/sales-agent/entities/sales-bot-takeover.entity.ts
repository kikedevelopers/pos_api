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

import { Company } from '@/modules/companies/entities/company.entity';

/**
 * `sales_bot_takeovers` — chats donde un HUMANO tomó el control. Mientras
 * `paused_until` sea futuro, el agente no responde en ese chat. Una fila por
 * (negocio, canal, chat); una nueva intervención solo extiende `paused_until`.
 */
@Entity('sales_bot_takeovers')
@Index('idx_sales_bot_takeovers_chat_unique', ['company_id', 'channel', 'chat_id'], {
  unique: true,
})
export class SalesBotTakeoverEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'varchar', length: 16 })
  channel!: string;

  @Column({ type: 'text' })
  chat_id!: string;

  @Column({ type: 'timestamptz' })
  paused_until!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
