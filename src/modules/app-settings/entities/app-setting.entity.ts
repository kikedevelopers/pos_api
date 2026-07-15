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
 * Claves de settings que PlacePos local conoce. Las mantenemos como constantes
 * tipadas para que el cliente y el servicio acuerden el namespace sin enums
 * rígidos (PlacePos los maneja como strings sueltos en `app-settings.routes.ts`).
 *
 * Si en el futuro se añade una clave nueva (`tax_rate`, etc.), se agrega aquí.
 * No usamos enum Postgres porque las claves crecen sin migración.
 */
export const APP_SETTING_KEYS = {
  APP_COLOR_MODE: 'app_color_mode',
  POS_MARGINS_ENABLED: 'pos_margins_enabled',
  POS_MARGINS: 'pos_margins',
  STRICT_INVENTORY_CONTROL: 'strict_inventory_control',
  // Incluir los pedidos (ticket_type = 'ORDER') en los INGRESOS del informe de
  // ventas y como sub-línea de facturación en Finanzas. NO afecta caja/recaudo
  // ni la ganancia cobrada canónica. Default false (comportamiento actual).
  INCLUDE_ORDERS_IN_REPORTS: 'include_orders_in_reports',
  // Sistema de PUNTOS de cliente (paridad PlacePos `customerPointsSettings`).
  // 3 keys: flag + base de pesos + puntos por base.
  CUSTOMER_POINTS_ENABLED: 'customer_points_enabled',
  CUSTOMER_POINTS_PESO_BASE: 'customer_points_peso_base',
  CUSTOMER_POINTS_PER_BASE: 'customer_points_per_base',
} as const;

export type AppSettingKey = (typeof APP_SETTING_KEYS)[keyof typeof APP_SETTING_KEYS];

/**
 * `app_settings` — Settings clave-valor per-company.
 *
 * Invariantes:
 *   - `UNIQUE(company_id, key)` (migración) — una sola row por (tenant, key).
 *   - `key` no puede ser cadena en blanco (CHECK).
 *
 * Multi-tenancy: toda query filtra por `company_id`. El service asigna
 * `app_setting.company_id := req.user.company_id`; nunca acepta override.
 */
@Entity('app_settings')
@Check('chk_app_settings_key_not_empty', 'length(btrim(key)) > 0')
export class AppSetting {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_app_settings_company_id')
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
  key!: string;

  @Column({ type: 'text' })
  value!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
