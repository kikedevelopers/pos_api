import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';
import { Company } from '@/modules/companies/entities/company.entity';

import { Product } from './product.entity';

/**
 * Dirección del movimiento. `IN` suma al stock, `OUT` lo resta.
 * El `quantity` SIEMPRE se persiste positivo; el signo lo lleva esta columna.
 */
export type InventoryMovementDirection = 'IN' | 'OUT';

/**
 * Motivos válidos. Espejo del CHECK constraint de la tabla y de los reasons
 * usados por PlacePos (`placepos/.../entities/InventoryMovement.ts`).
 *
 * Si se añade un motivo nuevo, debe hacerse en TRES sitios:
 *   1. Aquí (el tipo).
 *   2. El CHECK constraint en la migración.
 *   3. El reason que pase el caller a `adjustInventory`.
 */
export type InventoryMovementReason =
  | 'PURCHASE_RECEIVE'
  | 'PURCHASE_EDIT'
  | 'PURCHASE_ARCHIVE'
  | 'SALE'
  | 'SALE_VOID'
  | 'SALE_EDIT_CREDIT'
  | 'SALE_EDIT_DEBIT'
  | 'MANUAL_ADJUSTMENT'
  | 'BULK_IMPORT'
  | 'INITIAL_LOAD';

/**
 * Tipo de documento referenciado. Usado por reportes que quieren cruzar el
 * movimiento contra la transacción origen.
 */
export type InventoryMovementReferenceType =
  | 'sale_invoice'
  | 'credit_note'
  | 'purchase'
  | 'manual'
  | null;

/**
 * `inventory_movements` — Log auditable de cambios a `Product.stock`.
 *
 * Multi-tenant: la fila lleva `company_id` NOT NULL; todos los queries
 * filtran por él. Sin esta tabla es imposible auditar diferencias entre
 * stock teórico y físico.
 *
 * Insertado SIEMPRE en la misma transacción que muta `Product.stock`. El
 * helper `adjustInventory` se encarga de la consistencia.
 */
@Entity({ name: 'inventory_movements' })
@Index('idx_im_company_product_created', ['company_id', 'product_id', 'created_at'])
@Index('idx_im_company_reason_created', ['company_id', 'reason', 'created_at'])
@Check('chk_inventory_movements_qty_positive', 'quantity > 0')
@Check('chk_inventory_movements_direction', `direction IN ('IN','OUT')`)
export class InventoryMovement {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /**
   * FK a `companies`. Multi-tenant — toda lectura DEBE filtrar por aquí.
   */
  @Column({ type: 'bigint' })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'bigint' })
  product_id!: string;

  @ManyToOne(() => Product, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  /**
   * `IN` suma, `OUT` resta. Columna como VARCHAR(8) sin enum nativo para
   * compatibilidad con el CHECK constraint (no usamos type enum porque la
   * migración no creó el enum nativo PG — paridad con placepos).
   */
  @Column({ type: 'varchar', length: 8 })
  direction!: InventoryMovementDirection;

  /**
   * Cantidad SIEMPRE positiva (CHECK > 0). Para flujos OUT, el signo lo lleva
   * `direction`, no esta columna.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    transformer: NumericTransformer,
  })
  quantity!: number;

  @Column({ type: 'varchar', length: 24 })
  reason!: InventoryMovementReason;

  /** Stock antes de aplicar el delta (en la unidad mínima). */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    transformer: NumericTransformer,
  })
  stock_before!: number;

  /** Stock después de aplicar el delta. */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    transformer: NumericTransformer,
  })
  stock_after!: number;

  @Column({ type: 'varchar', length: 24, nullable: true })
  reference_type!: InventoryMovementReferenceType;

  @Column({ type: 'bigint', nullable: true })
  reference_id!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reference_code!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
