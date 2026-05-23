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

import { NumericTransformer } from '@/common/utils/numeric-transformer';
import { Company } from '@/modules/companies/entities/company.entity';

/**
 * `suppliers` — Proveedor de la company.
 *
 * --------------------------------------------------------------------------
 * Paridad PlacePos
 * --------------------------------------------------------------------------
 *
 *   Espejo byte-por-byte de `placepos/src/main/database/entities/Supplier.ts`,
 *   con la extensión cloud `company_id` (multi-tenancy).
 *
 *   Nombres preservados: `legal_name`, `broker`, `accumulated_debt`,
 *   `credit_balance`. Renombrarlos rompería el frontend Electron cuando opera
 *   en modo CLOUD apuntando a este API.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   Toda query DEBE filtrar por `company_id`. El service asigna
 *   `supplier.company_id := req.user.company_id`; nunca acepta override del
 *   payload.
 *
 * --------------------------------------------------------------------------
 * `accumulated_debt` / `credit_balance` — invariante de mutación
 * --------------------------------------------------------------------------
 *
 *   `accumulated_debt`: lo que la company le debe al proveedor (>= 0).
 *   `credit_balance`: saldo a favor de la company (>= 0).
 *
 *   Mutación EXCLUSIVA en Fase 8 (purchases) y Fase 9 (purchase_payments).
 *   El create en Fase 4 inicializa ambos a 0; el DTO de update NO los acepta.
 *   CHECK constraints garantizan no-negatividad en DB (defensa en profundidad).
 */
/**
 * Cuenta a la cual se le puede consignar al proveedor. Paridad placepos
 * (`entities/Supplier.ts → SupplierPaymentAccount`). Se persiste embebida
 * dentro de `payment_accounts` (JSONB), no en tabla separada.
 */
export interface SupplierPaymentAccount {
  entity_name: string;
  account_type: string;
  account_number: string;
  document_type: 'CC' | 'NIT';
  document_number: string;
  agreement_number: string | null;
}

@Entity('suppliers')
@Check('chk_suppliers_legal_name_not_empty', 'length(btrim(legal_name)) > 0')
@Check('chk_suppliers_accumulated_debt_non_negative', 'accumulated_debt >= 0')
@Check('chk_suppliers_credit_balance_non_negative', 'credit_balance >= 0')
export class Supplier {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /**
   * Tenant al que pertenece el supplier. Asignado por el service desde
   * `req.user.company_id`; nunca aceptado del payload.
   */
  @Index('idx_suppliers_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /**
   * Razón social del proveedor. NOT NULL, no-blank (CHECK en DB).
   */
  @Column({ type: 'text' })
  legal_name!: string;

  /**
   * Representante/contacto comercial. NO es un user del sistema; es solo un
   * snapshot textual.
   */
  @Column({ type: 'text', nullable: true })
  broker!: string | null;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  @Column({ type: 'text', nullable: true })
  phone!: string | null;

  @Column({ type: 'text', nullable: true })
  doc_number!: string | null;

  @Column({ type: 'text', nullable: true })
  email!: string | null;

  /**
   * Cuentas por pagar acumuladas. >= 0 (CHECK en DB). Mutación solo en
   * fases 8 y 9.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  accumulated_debt!: number;

  /**
   * Saldo a favor de la company. >= 0 (CHECK en DB). Mutación solo en
   * fases 8 y 9.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  credit_balance!: number;

  /**
   * Cuentas bancarias / billeteras a las que se le puede consignar al
   * proveedor. JSONB array — paridad placepos. El cliente las envía en el
   * payload de create/update y las recibe en GET.
   */
  @Column({ type: 'jsonb', nullable: false, default: () => "'[]'::jsonb" })
  payment_accounts!: SupplierPaymentAccount[];

  /**
   * Soft-delete convención PlacePos. Listados activos filtran
   * `is_archived = false`. Cubierto por índice parcial
   * `idx_suppliers_company_active`.
   */
  @Column({ type: 'boolean', default: false })
  is_archived!: boolean;

  /**
   * Snapshot del `full_name` del actor que creó el supplier. Texto congelado.
   */
  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  /**
   * ID del actor creador. Sin FK formal — campo informacional.
   */
  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
