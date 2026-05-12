import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';
import { Company } from '@/modules/companies/entities/company.entity';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';

import { CorrectionSource } from './correction-source.entity';
import { CreditNoteLine } from './credit-note-line.entity';

/**
 * Tipo lógico de la nota. Espejo PlacePos `NoteType`.
 *
 *   - `CREDIT`: reduce el total consolidado de la venta original. Combina
 *     con `FULL_VOID` o `PARTIAL_VOID`.
 *   - `DEBIT`: aumenta el total consolidado. Combina solo con `ADDITION`.
 *
 * `enumName: 'note_type'` debe coincidir EXACTAMENTE con el `CREATE TYPE`
 * de la migración 1747009500000.
 */
export enum NoteType {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

/**
 * Tipo de operación contable. Espejo PlacePos `OperationType`.
 *
 *   - `FULL_VOID`: anula la venta completa (solo UNA por venta).
 *   - `PARTIAL_VOID`: anula líneas o cantidades específicas.
 *   - `ADDITION`: agrega cargos (intereses, recargos).
 *
 * `enumName: 'operation_type'` debe coincidir EXACTAMENTE con el
 * `CREATE TYPE` de la migración 1747009500000.
 */
export enum OperationType {
  FULL_VOID = 'FULL_VOID',
  PARTIAL_VOID = 'PARTIAL_VOID',
  ADDITION = 'ADDITION',
}

/**
 * `credit_notes` — Nota crédito o débito sobre una venta.
 *
 * Espejo de `placepos/src/main/database/entities/CreditNote.ts` con
 * extensión cloud `company_id` (multi-tenancy).
 *
 * --------------------------------------------------------------------------
 * Invariantes enforced en DB
 * --------------------------------------------------------------------------
 *
 *   - `note_number` no-blank.
 *   - `subtotal`, `tax_total`, `total` >= 0.
 *   - Combinación legal note_type x operation_type:
 *       CREDIT + (FULL_VOID | PARTIAL_VOID) | DEBIT + ADDITION
 *   - UNIQUE per-company `(company_id, note_number)`.
 *   - UNIQUE per-company parcial: SOLO UNA `operation_type = FULL_VOID`
 *     activa por venta (`(company_id, sale_invoice_id) WHERE
 *     operation_type='FULL_VOID' AND is_deleted = false`).
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   Toda query DEBE filtrar por `company_id`. El service asigna
 *   `note.company_id := req.user.company_id`; nunca acepta override del
 *   payload.
 *
 *   Cross-tenant guards: `sale_invoice_id` y `customer_id` se validan
 *   contra la company antes de cualquier INSERT.
 *
 * --------------------------------------------------------------------------
 * Soft-delete
 * --------------------------------------------------------------------------
 *
 *   Convención PlacePos (`is_deleted` boolean). Las notas anuladas conservan
 *   el histórico contable para auditoría.
 */
@Entity('credit_notes')
@Check('chk_credit_notes_note_number_not_empty', 'length(btrim(note_number)) > 0')
@Check('chk_credit_notes_subtotal_non_negative', 'subtotal >= 0')
@Check('chk_credit_notes_tax_total_non_negative', 'tax_total >= 0')
@Check('chk_credit_notes_total_non_negative', 'total >= 0')
@Check(
  'chk_credit_notes_type_operation_consistency',
  `(note_type = 'CREDIT' AND operation_type IN ('FULL_VOID', 'PARTIAL_VOID'))
   OR (note_type = 'DEBIT' AND operation_type = 'ADDITION')`,
)
export class CreditNote {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_credit_notes_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'bigint', nullable: false })
  sale_invoice_id!: string;

  @ManyToOne(() => SaleInvoice, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'sale_invoice_id' })
  sale_invoice!: SaleInvoice;

  @Column({ type: 'bigint', nullable: true })
  customer_id!: string | null;

  @ManyToOne(() => Customer, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer | null;

  @Column({ type: 'text', nullable: false })
  note_number!: string;

  @Column({ type: 'enum', enum: NoteType, enumName: 'note_type' })
  note_type!: NoteType;

  @Column({ type: 'enum', enum: OperationType, enumName: 'operation_type' })
  operation_type!: OperationType;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  subtotal!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  tax_total!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  total!: number;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @Column({ type: 'boolean', default: false })
  is_deleted!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @OneToMany(() => CreditNoteLine, (l) => l.credit_note)
  lines!: CreditNoteLine[];

  @OneToOne(() => CorrectionSource, (cs) => cs.credit_note)
  correction_source!: CorrectionSource | null;
}
