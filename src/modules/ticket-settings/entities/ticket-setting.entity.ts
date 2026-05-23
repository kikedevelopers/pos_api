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
 * Tipos de ticket cuyo folio gestiona PlacePos. Coincide byte-a-byte con
 * `TicketSettingType` del cliente local (`placepos/src/main/database/enums`).
 *
 * El `enumName: 'ticket_setting_type'` debe coincidir EXACTAMENTE con el
 * `CREATE TYPE` de la migración `1747009020000-create-ticket-settings-table.ts`.
 */
export enum TicketSettingType {
  ORDER = 'ORDER',
  SALE = 'SALE',
  CREDIT_NOTE = 'CREDIT_NOTE',
  DEBIT_NOTE = 'DEBIT_NOTE',
  PURCHASE = 'PURCHASE',
  PURCHASE_PAYMENT = 'PURCHASE_PAYMENT',
}

/**
 * `ticket_settings` — Configuración de folios por (company, ticket_type).
 *
 * Invariantes:
 *   - Para cada (company_id, ticket_type) existe exactamente UNA fila (UNIQUE
 *     parcial en migración + seed en `RegisterAction`).
 *   - `current_number >= 0` (CHECK).
 *   - El incremento del consecutivo se hace SIEMPRE vía
 *     `IncrementTicketNumberAction` (UPDATE ... RETURNING) — nunca con
 *     `findOne + ++ + save` para evitar race conditions.
 *
 * `prefix`/`suffix` son opcionales (nullable). Cuando ambos son null el
 * número formateado es solo el padded number (ver `formatTicketNumber`).
 */
@Entity('ticket_settings')
@Check('chk_ticket_settings_current_number_non_negative', 'current_number >= 0')
export class TicketSetting {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_ticket_settings_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'enum', enum: TicketSettingType, enumName: 'ticket_setting_type' })
  ticket_type!: TicketSettingType;

  @Column({ type: 'integer', default: 0 })
  current_number!: number;

  @Column({ type: 'text', nullable: true })
  prefix!: string | null;

  @Column({ type: 'text', nullable: true })
  suffix!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
