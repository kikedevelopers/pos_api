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
 * `packagings` — Empaque/unidad de envase asociable a un `Product`.
 *
 * --------------------------------------------------------------------------
 * Invariantes enforced en DB
 * --------------------------------------------------------------------------
 *
 *   - `name` no puede ser cadena en blanco
 *     (`chk_packagings_name_not_empty`).
 *   - `value` debe ser >= 0
 *     (`chk_packagings_value_non_negative`).
 *   - `(company_id, lower(btrim(name)))` UNIQUE entre registros activos
 *     (índice parcial `idx_packagings_company_name_unique`). Archivar un
 *     empaque libera el nombre para reuso. La traducción a 409 se hace en
 *     `internal/constraint-errors.ts`.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * Toda query DEBE filtrar por `company_id`. El service asigna
 * `packaging.company_id := req.user.company_id`; nunca acepta override
 * del payload.
 *
 * --------------------------------------------------------------------------
 * Paridad de contrato HTTP con PlacePos
 * --------------------------------------------------------------------------
 *
 * El campo expuesto al cliente se llama `value` (espejo de PlacePos). Aquí
 * lo almacenamos también como `value` para que el mapper en el controller
 * sea de identidad. La precisión se eleva a 4 decimales por §2.5 de CLAUDE.md
 * (cantidades = numeric(15,4)), divergencia documentada en la migración.
 */
@Entity('packagings')
@Check('chk_packagings_name_not_empty', 'length(btrim(name)) > 0')
@Check('chk_packagings_value_non_negative', 'value >= 0')
export class Packaging {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /**
   * Tenant. Mapeado como `string` porque pg devuelve bigint como string.
   */
  @Index('idx_packagings_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'text' })
  name!: string;

  /**
   * Cantidad de unidades dentro del empaque (numeric(15,4)).
   * Coerced a `number` por el `NumericTransformer` al leer; dentro del
   * service, vuélvelo a `Big` antes de operar.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  value!: number;

  /**
   * Soft-delete convención PlacePos. Listados activos filtran
   * `is_archived = false`.
   */
  @Column({ type: 'boolean', default: false })
  is_archived!: boolean;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
