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
 * `kanban_boards` — un "tablero" del Kanban colaborativo. Es el contenedor
 * vertical de tarjetas; los tableros se disponen en una tira horizontal y se
 * ordenan por `position` (rank fraccionado). Compartido por toda la company
 * (multi-tenant por `company_id`). Módulo AISLADO: no lo referencia ningún otro.
 *
 * `position` es `double precision` (rank fraccionado): mover/insertar un tablero
 * es un único UPDATE por punto medio, sin renumerar el resto. El módulo rebalancea
 * si el hueco se agota. Índice `(company_id, position)` para leer ordenado y rápido.
 */
@Entity('kanban_boards')
@Check('chk_kanban_boards_title_not_empty', 'length(btrim(title)) > 0')
@Index('idx_kanban_boards_company_pos', ['company_id', 'position'])
export class KanbanBoard {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_kanban_boards_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'text', nullable: false })
  title!: string;

  @Column({ type: 'double precision', nullable: false })
  position!: number;

  /** Snapshot del nombre de quien creó el tablero (texto congelado). */
  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  /** `users.id` de quien creó el tablero (informacional, sin FK formal). */
  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  /**
   * Llave de idempotencia (opcional): el cliente la genera una vez por intento
   * y la reusa en reintentos. Protegida por índice único parcial
   * `(company_id, client_operation_id) WHERE client_operation_id IS NOT NULL`.
   */
  @Column({ type: 'text', nullable: true })
  client_operation_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
