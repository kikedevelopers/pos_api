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
import { User } from '@/modules/users/entities/user.entity';

/**
 * `cash_registers` — Caja registradora PERMANENTE por usuario.
 *
 * --------------------------------------------------------------------------
 * Modelo (paridad PlacePos)
 * --------------------------------------------------------------------------
 *
 * Un row persistente por (`company_id`, `user_id`). NO hay concepto de turno:
 * el `balance` se mutea con cada operación (cobro, gasto, transferencia,
 * ajuste). PlacePos garantiza UNICIDAD por `user_id` global; aquí lo
 * componemos con `company_id` para multi-tenancy.
 *
 * `user_id` es NULL admisible para soportar:
 *   - Cajas históricas si el `User` referenciado se elimina (FK ON DELETE
 *     SET NULL preserva el row para auditoría).
 *   - Cajas de operadores que no tienen fila en `users` (escenarios futuros).
 *
 * --------------------------------------------------------------------------
 * Invariantes enforced en DB
 * --------------------------------------------------------------------------
 *
 *   - `balance >= 0` (`chk_cash_registers_balance_non_negative`).
 *   - `base_amount >= 0` (`chk_cash_registers_base_amount_non_negative`).
 *   - UNIQUE parcial `(company_id, user_id) WHERE user_id IS NOT NULL`.
 *
 * --------------------------------------------------------------------------
 * Reglas de uso (service-level)
 * --------------------------------------------------------------------------
 *
 *   - El service NUNCA crea más de una caja por (company_id, user_id) —
 *     `getOrCreateCashRegisterForUser` consolida la creación atómica.
 *   - El balance se mutea SIEMPRE con lock pessimistic_write para evitar
 *     lost-update en cobros/pagos concurrentes.
 *   - Los `CashRegisterLog` son AUDITORÍA del cambio de balance; el balance
 *     físico vive en esta columna, NO se deriva de los logs (a diferencia
 *     del modelo de turnos previo).
 */
@Entity('cash_registers')
@Check('chk_cash_registers_balance_non_negative', 'balance >= 0')
@Check('chk_cash_registers_base_amount_non_negative', 'base_amount >= 0')
export class CashRegister {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_cash_registers_company_id')
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
   * Dueño de la caja. FK a `users(id) ON DELETE SET NULL`. NULL admitido
   * (caja histórica o de actor sin User correspondiente).
   *
   * Para empleados (entidad `Employee`) que NO tienen una fila en `users`
   * pero sí pueden operar caja, este modelo NO los soporta: las actions
   * deben rechazar la operación con 422 hasta que se introduzca
   * `Employee.user_id` o se reorganice el dominio.
   */
  @Column({ type: 'bigint', nullable: true })
  user_id!: string | null;

  @ManyToOne(() => User, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  /**
   * Balance corriente físico de la caja. Mutado con cada operación dentro de
   * una transacción con lock pessimistic_write. CHECK >= 0 a nivel DB.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  balance!: number;

  /**
   * Fondo fijo (base) configurable por el owner. NO se considera "saldo" para
   * la operación; sirve para reportes "diferencia entre caja contada y fondo
   * fijo". CHECK >= 0 a nivel DB.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  base_amount!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
