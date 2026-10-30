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

import type { ChatTurn } from '@/modules/ai/internal/gemini.types';
import { Company } from '@/modules/companies/entities/company.entity';

import type { SellerCart } from '../internal/cart';

/**
 * `sales_bot_conversations` — memoria de conversación del vendedor por chat.
 * Persistida para que un reinicio/deploy no haga que el agente olvide lo hablado
 * ni vuelva a saludar a mitad de la conversación.
 */
@Entity('sales_bot_conversations')
@Index('idx_sales_bot_conversations_chat_unique', ['company_id', 'channel', 'chat_id'], {
  unique: true,
})
@Check('chk_sales_bot_conversations_chat_not_empty', 'length(btrim(chat_id)) > 0')
export class SalesBotConversationEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'varchar', length: 32 })
  channel!: string;

  @Column({ type: 'text' })
  chat_id!: string;

  /** Últimos turnos (cliente + vendedor). */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  turns!: ChatTurn[];

  /** Día (YYYY-MM-DD, Colombia) del último mensaje del cliente. */
  @Column({ type: 'varchar', length: 10, nullable: true })
  last_day!: string | null;

  /** Firmas de pedidos ya cerrados en la conversación vigente. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  order_signatures!: string[];

  /** Pedido en curso (carrito + datos de entrega); `null` = nada en curso. */
  @Column({ type: 'jsonb', nullable: true })
  cart!: SellerCart | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
