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
 * Tipo de cuenta bancaria. Coincide con el enum `AccountType` de PlacePos
 * (`placepos/src/main/database/enums/AccountType.ts`). El nombre del tipo
 * Postgres es `bank_account_type` (singular, para no colisionar con la
 * columna del mismo nombre).
 */
export enum BankAccountType {
  SAVINGS = 'savings',
  CHECKING = 'checking',
}

/**
 * `banks` — Cuenta bancaria de una company.
 *
 * Multi-tenancy: toda query DEBE filtrar por `company_id`. El service asigna
 * `company_id := req.user.company_id`. UNIQUE compuesto per-company sobre
 * `(company_id, name, account_number)` (índice parcial activos).
 *
 * Soft-delete via `is_archived`. Los `payments` históricos pueden seguir
 * apuntando a bancos archivados; por eso NUNCA se borra físicamente.
 */
@Entity('banks')
@Check('chk_banks_name_not_empty', 'length(btrim(name)) > 0')
@Check('chk_banks_account_number_not_empty', 'length(btrim(account_number)) > 0')
@Check('chk_banks_balance_not_null', 'balance IS NOT NULL')
export class Bank {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_banks_company_id')
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

  @Column({ type: 'text' })
  account_number!: string;

  @Column({
    type: 'enum',
    enum: BankAccountType,
    enumName: 'bank_account_type',
    default: BankAccountType.SAVINGS,
  })
  account_type!: BankAccountType;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  balance!: number;

  @Column({ type: 'boolean', default: false })
  available_in_pos!: boolean;

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
