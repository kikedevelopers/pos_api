import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

/**
 * Aceptación de un acuerdo (disclaimer / términos y condiciones) por parte de un
 * usuario. Diseño GENÉRICO: el contenido de cada acuerdo vive en el front (por
 * `agreement_key` + `version`); esta tabla solo registra QUIÉN aceptó QUÉ y en
 * qué versión, para no tocar el esquema al agregar nuevos acuerdos.
 *
 * Keyeado por `(company_id, user_id, account, agreement_key)`: una fila por
 * usuario y acuerdo; en re-aceptación se actualiza `version` + `accepted_at`.
 * `account` desambigua el espacio de ids entre `users` (owner/manager) y
 * `employees`, que pueden colisionar.
 */
@Entity('agreement_acceptances')
@Unique('uq_agreement_acceptances_user_agreement', [
  'company_id',
  'user_id',
  'account',
  'agreement_key',
])
export class AgreementAcceptance {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_agreement_acceptances_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Id del usuario autenticado que aceptó (users o employees, ver `account`). */
  @Column({ type: 'bigint', nullable: false })
  user_id!: string;

  /** 'user' (owner/manager) | 'employee'. Desambigua el espacio de ids. */
  @Column({ type: 'text', nullable: false })
  account!: string;

  /** Clave estable del acuerdo, ej. 'whatsapp_liability_disclaimer'. */
  @Column({ type: 'text', nullable: false })
  agreement_key!: string;

  /** Versión aceptada. Si el texto cambia se sube la versión y se re-pide. */
  @Column({ type: 'integer', nullable: false, default: 1 })
  version!: number;

  /** Instante de la última aceptación (se actualiza al re-aceptar). */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  accepted_at!: Date;
}
