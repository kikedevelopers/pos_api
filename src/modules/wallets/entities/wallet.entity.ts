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
 * `wallets` — Billetera (caja virtual no bancaria) de una company.
 *
 * Espejo del `Wallet.ts` de PlacePos con `company_id` añadido para
 * multi-tenancy. Por defecto, cada company nueva tiene una wallet "Efectivo"
 * creada por el seed del `RegisterAction` (cableado vía
 * `CreateDefaultWalletAction`).
 *
 * Soft-delete via `is_archived`. UNIQUE per-company sobre `name` (entre
 * activas) — coordinado con el índice parcial de la migración.
 */
@Entity('wallets')
@Check('chk_wallets_name_not_empty', 'length(btrim(name)) > 0')
@Check('chk_wallets_balance_not_null', 'balance IS NOT NULL')
export class Wallet {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_wallets_company_id')
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

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  balance!: number;

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
