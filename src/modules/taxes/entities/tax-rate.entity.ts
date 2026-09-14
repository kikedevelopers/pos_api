import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';

/**
 * `tax_rates` — Catálogo de tarifas de IVA de Colombia.
 *
 * Es un catálogo GLOBAL (sin `company_id`): las tarifas de IVA son nacionales y
 * fijas (19%, 5%, 0% y Exento), iguales para todos los negocios. Se siembra una
 * sola vez en la migración y es de solo lectura desde la app; ningún tenant las
 * edita. Un producto referencia una fila de aquí (`products.tax_rate_id`) y de
 * ella sale la tarifa con la que se desglosa la base gravable y el IVA de cada
 * precio.
 *
 * `code` es la llave estable e inmutable (`IVA_19`, `IVA_5`, `IVA_0`, `EXEMPT`)
 * para poder referirse a una tarifa sin depender del id autogenerado.
 *
 * "Exento" y "0%" comparten tarifa 0 pero son fiscalmente distintos: Exento da
 * a entender que el producto no causa IVA; 0% es gravado a tarifa cero. Se
 * distinguen por `code`.
 */
@Entity('tax_rates')
@Check('chk_tax_rates_rate_valid', 'rate >= 0 AND rate <= 100')
export class TaxRate {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /** Llave estable e inmutable: IVA_19 | IVA_5 | IVA_0 | EXEMPT. */
  @Column({ type: 'text', unique: true })
  code!: string;

  /** Etiqueta visible: "IVA 19%", "Exento", … */
  @Column({ type: 'text' })
  name!: string;

  /** Tarifa porcentual (19, 5, 0). Exento y 0% valen 0. */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  rate!: number;

  /** Descripción de para qué se usa / dónde aplica (orienta al usuario). */
  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Orden de presentación en el select. */
  @Column({ type: 'integer', default: 0 })
  sort_order!: number;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
