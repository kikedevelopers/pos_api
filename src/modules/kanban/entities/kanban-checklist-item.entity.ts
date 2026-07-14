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

import { KanbanCard } from './kanban-card.entity';

/**
 * `kanban_checklist_items` — ítem de la lista de tareas de una tarjeta. Se ordena
 * dentro de su tarjeta por `position` (rank fraccionado). Borrar la tarjeta borra
 * sus ítems (FK `ON DELETE CASCADE`). Multi-tenant por `company_id`.
 *
 * Índice `(company_id, card_id, position)` para cargar el checklist de una tarjeta
 * ya ordenado en un solo escaneo de índice.
 */
@Entity('kanban_checklist_items')
@Check('chk_kanban_checklist_text_not_empty', 'length(btrim(text)) > 0')
@Index('idx_kanban_checklist_company_card_pos', ['company_id', 'card_id', 'position'])
export class KanbanChecklistItem {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_kanban_checklist_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @Index('idx_kanban_checklist_card_id')
  @Column({ type: 'bigint', nullable: false })
  card_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @ManyToOne(() => KanbanCard, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'card_id' })
  card!: KanbanCard;

  @Column({ type: 'text', nullable: false })
  text!: string;

  @Column({ type: 'boolean', default: false })
  is_done!: boolean;

  @Column({ type: 'double precision', nullable: false })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
