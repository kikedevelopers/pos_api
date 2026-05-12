import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

import { CreditNote } from './credit-note.entity';

/**
 * Origen del dinero / crédito que respalda una corrección. Espejo PlacePos.
 *
 *   - `bank` / `wallet`: la devolución salió de una cuenta interna.
 *   - `cash_register`: la devolución salió en efectivo de la caja abierta.
 *   - `sale_credit`: la corrección ajustó el `SaleCredit` (deuda del
 *     cliente) en lugar de devolver dinero físico.
 *
 * Validado por CHECK constraint en la migración.
 */
export type CorrectionSourceType = 'bank' | 'wallet' | 'cash_register' | 'sale_credit';

/**
 * `correction_sources` — Rastro de auditoría para devoluciones / ajustes
 * originados por una `CreditNote`.
 *
 * Espejo de `placepos/src/main/database/entities/CorrectionSource.ts`.
 *
 * --------------------------------------------------------------------------
 * Relación 1:1 con CreditNote
 * --------------------------------------------------------------------------
 *
 *   `credit_note_id` UNIQUE per-company. Cuando una nota no genera retorno
 *   de dinero (PARTIAL_VOID sin pago, ADDITION) NO se crea row — la
 *   relación es opcional.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   `company_id` NOT NULL coincide con `credit_note.company_id`. El service
 *   lo asigna desde el JWT — nunca acepta override.
 */
@Entity('correction_sources')
@Check(
  'chk_correction_sources_source_type_values',
  `source_type IN ('bank', 'wallet', 'cash_register', 'sale_credit')`,
)
@Check('chk_correction_sources_source_name_not_empty', 'length(btrim(source_name)) > 0')
export class CorrectionSource {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_correction_sources_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @OneToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'bigint', nullable: false })
  credit_note_id!: string;

  @OneToOne(() => CreditNote, (cn) => cn.correction_source, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'credit_note_id' })
  credit_note!: CreditNote;

  @Column({ type: 'text', nullable: false })
  source_type!: CorrectionSourceType;

  @Column({ type: 'bigint', nullable: false })
  source_id!: string;

  @Column({ type: 'text', nullable: false })
  source_name!: string;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
