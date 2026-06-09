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
 * Tipo de persona del cliente. Espejo de `placepos/src/main/database/enums/PersonType`.
 *
 *   - `INDIVIDUAL`: persona natural.
 *   - `COMPANY`: persona jurídica.
 *
 * El `enumName: 'person_type'` debe coincidir EXACTAMENTE con el `CREATE TYPE`
 * de la migración. Si difiere, TypeORM crearía un tipo paralelo.
 */
export enum PersonType {
  INDIVIDUAL = 'INDIVIDUAL',
  COMPANY = 'COMPANY',
}

/**
 * `customers` — Cliente final de la company.
 *
 * --------------------------------------------------------------------------
 * Paridad PlacePos
 * --------------------------------------------------------------------------
 *
 *   El shape coincide byte-por-byte con `placepos/src/main/database/entities/
 *   Customer.ts`, con dos extensiones cloud no-breaking:
 *
 *     - `company_id` (multi-tenancy).
 *     - `is_archived` (soft-delete capability — el frontend Electron lo
 *       ignora porque PlacePos local no archiva customers).
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   Toda query DEBE filtrar por `company_id`. El service asigna
 *   `customer.company_id := req.user.company_id`; nunca acepta override del
 *   payload.
 *
 * --------------------------------------------------------------------------
 * `balance` — invariante de mutación
 * --------------------------------------------------------------------------
 *
 *   Columna SIGNED:
 *     - `> 0`: la company le debe dinero al cliente (anticipo, devolución).
 *     - `< 0`: el cliente le debe a la company (venta a crédito impaga).
 *
 *   Mutación EXCLUSIVA en las fases siguientes (6 ventas/créditos, 8 notas,
 *   9 pagos). El create en Fase 4 lo inicializa a 0; el DTO de update NO lo
 *   acepta. Cualquier intento de poner balance arbitrario desde el cliente
 *   es strippeado por `whitelist: true` del ValidationPipe global.
 */
@Entity('customers')
@Check('chk_customers_name_not_empty', 'length(btrim(name)) > 0')
export class Customer {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /**
   * Tenant al que pertenece el cliente. Asignado por el service desde
   * `req.user.company_id`; nunca aceptado del payload.
   */
  @Index('idx_customers_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({
    type: 'enum',
    enum: PersonType,
    enumName: 'person_type',
    default: PersonType.INDIVIDUAL,
  })
  person_type!: PersonType;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  email!: string | null;

  @Column({ type: 'text', nullable: true })
  phone!: string | null;

  @Column({ type: 'text', nullable: true })
  doc_number!: string | null;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  /**
   * SIGNED. Ver JSDoc del header. Mutación solo en fases 6/8/9.
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
   * Soft-delete capability cloud. PlacePos local no archiva customers; el
   * frontend ignora este campo.
   */
  @Column({ type: 'boolean', default: false })
  is_archived!: boolean;

  /**
   * Saldo de anticipos del cliente (dinero recibido por adelantado, NO ligado
   * todavía a una venta). Campo DEDICADO — distinto de `balance` por decisión
   * del contrato `CONTRACT_customer_advance_archive.md`.
   *
   * Invariante: `>= 0`. Solo se MUTA (suma) dentro de la creación de un
   * anticipo (`POST /customers/:id/advances`), con Big.js, dentro de la
   * transacción atómica que también registra el ingreso de dinero. Nunca
   * negativo. No se acepta desde ningún DTO público.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  advance_balance!: number;

  /**
   * Snapshot del `full_name` del actor (User u Employee) que creó al cliente.
   * Texto congelado al momento de creación.
   */
  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  /**
   * ID del actor creador. Sin FK formal — campo informacional. Mapeado como
   * `string | null` porque pg devuelve bigint como string.
   */
  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
