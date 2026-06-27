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

import type { PermissionKey } from '../internal/permission-catalog';

/**
 * `roles` — Rol PERSONALIZADO de acceso a módulos (FASE 1, modelo de datos).
 *
 * Reemplaza progresivamente el control por rol fijo (`@Roles` owner/manager/
 * employee). Un `Employee` apunta a un `role_id`; el rol declara qué módulos
 * puede VER/ACCEDER vía su array `permissions` (keys del catálogo canónico,
 * idéntico a placepos). owner/superadmin SIEMPRE tienen acceso total y no
 * dependen de esta tabla.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   Toda query DEBE filtrar por `company_id`. El service (Fase 2) asignará
 *   `role.company_id := req.user.company_id`; nunca acepta override del payload.
 *
 * --------------------------------------------------------------------------
 * UNIQUE per-company (índice funcional)
 * --------------------------------------------------------------------------
 *
 *   `idx_roles_company_name_unique` cubre `(company_id, lower(btrim(name)))`
 *   para impedir nombres duplicados (case/trim-insensitive) dentro de una
 *   company. Es un índice de EXPRESIÓN: vive como SQL crudo en la migración,
 *   no se expresa con decoradores.
 *
 * --------------------------------------------------------------------------
 * Roles de sistema (`is_system = true`)
 * --------------------------------------------------------------------------
 *
 *   Sembrados al crear la company (Administrador, Cajero). No son borrables (la
 *   regla la aplica el service; la DB sólo persiste el flag). 'Administrador'
 *   además es INMUTABLE (`is_editable = false`).
 */
@Entity('roles')
@Check('chk_roles_name_not_empty', 'length(btrim(name)) > 0')
export class Role {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /**
   * Tenant dueño del rol. Mapeado como `string` porque pg devuelve bigint como
   * string.
   */
  @Index('idx_roles_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'text', nullable: false })
  name!: string;

  /** Color hex de presentación (ej. '#6366f1'). Opcional. */
  @Column({ type: 'text', nullable: true })
  color!: string | null;

  /** Nombre de ícono lucide de presentación (ej. 'UserCog'). Opcional. */
  @Column({ type: 'text', nullable: true })
  icon!: string | null;

  /**
   * Array de keys de permiso del catálogo canónico (`PERMISSION_KEYS`).
   * Persistido como `jsonb` con DEFAULT '[]'. El service de Fase 2 valida cada
   * entrada con `isValidPermissionKey` antes de guardar.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  permissions!: PermissionKey[];

  /**
   * Rol de fábrica no borrable. Sembrado por `seedSystemRolesForCompany`. El
   * service de Fase 2 impide eliminarlo/renombrarlo; la DB sólo guarda el flag.
   */
  @Column({ type: 'boolean', default: false })
  is_system!: boolean;

  /**
   * ¿El rol se puede editar/eliminar? Por defecto `true`. El rol de fábrica
   * 'Administrador' nace con `is_editable = false` (INMUTABLE: acceso total
   * inamovible, ni el owner lo edita o borra). 'Cajero' y todo rol creado vía
   * API son editables. Los actions de update/delete rechazan (422) cuando es
   * `false`; la DB sólo persiste el flag.
   */
  @Column({ type: 'boolean', default: true })
  is_editable!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
