import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '@/modules/users/entities/user.entity';

import { Company } from './company.entity';

/**
 * `company_members` — Pertenencia de un usuario (owner) a varias companies
 * (sucursales). Soporte multi-sucursal: un mismo owner puede operar varias
 * empresas y cambiar entre ellas re-emitiendo el JWT con otra `company_id`.
 *
 * --------------------------------------------------------------------------
 * Modelo de mínimo impacto
 * --------------------------------------------------------------------------
 *
 *   - `users.company_id` SE CONSERVA como la company "primaria/por defecto"
 *     (la del login). Esta tabla NO la reemplaza: es la fuente de verdad para
 *     autorizar el switch (anti-IDOR) y listar las sucursales del owner.
 *   - Las ~37 entidades de negocio siguen con su `company_id` y su scoping por
 *     el `company_id` del JWT — esta tabla no las toca.
 *
 * `id`/`user_id`/`company_id` se mapean a `string` (pg devuelve bigint como
 * string), igual que `User`/`Company`.
 */
@Entity('company_members')
@Index('idx_company_members_user_company_unique', ['user_id', 'company_id'], { unique: true })
@Index('idx_company_members_user_id', ['user_id'])
export class CompanyMember {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint', nullable: false })
  user_id!: string;

  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  /**
   * Rol del usuario en esa company. Hoy siempre `'owner'` (un owner dueño de
   * varias sucursales). Se deja como texto para futuras extensiones.
   */
  @Column({ type: 'text', default: 'owner' })
  role!: string;

  /**
   * Sucursal activa (seleccionable) vs suspendida. Cuando el admin reduce el
   * límite o el owner reconcilia, las sucursales fuera del límite quedan
   * `is_active=false` (datos intactos, reversible). El negocio principal
   * (`company.is_branch=false`) permanece siempre activo.
   */
  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
