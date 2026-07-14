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

import { KanbanBoard } from './kanban-board.entity';

/**
 * `kanban_cards` — una tarjeta dentro de un tablero (`board_id`). Se ordena
 * dentro de su tablero por `position` (rank fraccionado). Borrar un tablero
 * borra sus tarjetas (FK `ON DELETE CASCADE`). Multi-tenant por `company_id`.
 *
 * Índice `(company_id, board_id, position)` para cargar las tarjetas de un
 * tablero ya ordenadas en un solo escaneo de índice.
 */
@Entity('kanban_cards')
@Check('chk_kanban_cards_title_not_empty', 'length(btrim(title)) > 0')
@Index('idx_kanban_cards_company_board_pos', ['company_id', 'board_id', 'position'])
export class KanbanCard {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_kanban_cards_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @Index('idx_kanban_cards_board_id')
  @Column({ type: 'bigint', nullable: false })
  board_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @ManyToOne(() => KanbanBoard, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'board_id' })
  board!: KanbanBoard;

  @Column({ type: 'text', nullable: false })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'double precision', nullable: false })
  position!: number;

  /** Snapshot del nombre de quien creó la tarjeta (texto congelado). */
  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  /** `users.id` de quien creó la tarjeta (informacional, sin FK formal). */
  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  /**
   * Llave de idempotencia (opcional). Índice único parcial
   * `(company_id, client_operation_id) WHERE client_operation_id IS NOT NULL`.
   */
  @Column({ type: 'text', nullable: true })
  client_operation_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
