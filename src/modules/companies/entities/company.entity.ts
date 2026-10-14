import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { POS_MODES, type PosMode } from '@/common/pos-mode/pos-mode.util';
import { NumericTransformer } from '@/common/utils/numeric-transformer';

import { User } from '@/modules/users/entities/user.entity';

/**
 * Origen de creación de la company.
 *
 *   - `web`: registro normal vía `POST /auth/register` (web/cloud directo).
 *   - `offline_migration`: la cuenta cloud se creó DESDE un POS offline
 *     (`placepos`) en su primera migración a "modo cloud". Estas cuentas
 *     arrancan con un trial más corto (`SUBSCRIPTION_MIGRATION_DAYS`).
 */
export type CompanyOrigin = 'web' | 'offline_migration';

/**
 * `companies` — Tenant raíz del sistema multi-tenant.
 *
 * No lleva `owner_id` (divergencia intencional vs PlacePos): el owner se
 * resuelve por `users.company_id` + `users.type = 'owner'`. Esto rompe el
 * ciclo de FK y permite que `POST /auth/register` cree Company y User en
 * una sola transacción sin deferred constraints.
 *
 * `id` se mapea a `string` en TypeORM porque pg devuelve `bigint` como
 * string (un `number` JS no cubre 2^53+1). El service convertirá a number
 * cuando lo serialice a JSON para mantener el contrato PlacePos (ids
 * numéricos), o lo dejará como string si el flujo así lo requiere.
 */
@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_companies_name')
  @Column({ type: 'text' })
  name!: string;

  /**
   * RIF/NIT/CUIT/RFC. Sin UNIQUE global por variabilidad de formatos
   * entre países y posibilidad legítima de duplicados.
   */
  @Column({ type: 'text', nullable: true })
  document_number!: string | null;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  balance!: number;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  /** Email de contacto del negocio. Distinto del email del owner. */
  @Column({ type: 'text', nullable: true })
  email!: string | null;

  @Column({ type: 'text', nullable: true })
  phone_number!: string | null;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  break_even_amount!: number;

  @Column({ type: 'integer', default: 30 })
  break_even_period_days!: number;

  /**
   * Origen de la cuenta: `'web'` (registro normal) | `'offline_migration'`
   * (creada desde un POS offline en su primera migración a cloud). Default
   * `'web'` en DB para que las companies existentes queden marcadas como
   * registro normal sin necesidad de backfill explícito.
   */
  @Column({ type: 'varchar', length: 32, default: 'web' })
  origin!: CompanyOrigin;

  /**
   * Multi-sucursal: `false` para el primer negocio del owner (registro normal),
   * `true` para cada sucursal creada después vía `POST /branches`. Solo
   * informativo/UI y base para el cobro futuro por sucursal — el aislamiento de
   * datos lo sigue garantizando `company_id`, no este flag. Default `false` en
   * DB para que las companies existentes queden como negocio principal sin
   * backfill.
   */
  @Column({ type: 'boolean', default: false })
  is_branch!: boolean;

  /**
   * Gate de Facturación Electrónica del negocio. `false` por defecto: la FE no
   * viene activa; se habilita explícitamente desde el panel superadmin. TODO el
   * proceso de FE (armado, firma y envío a la DIAN) corre en el API externo de
   * Laravel (APIDIAN) — este flag solo decide si el negocio puede emitir. La
   * configuración fiscal restante se sumará a esta misma entidad más adelante.
   */
  @Column({ type: 'boolean', default: false })
  electronic_billing_enabled!: boolean;

  /**
   * Gate de acceso al asistente **Place** (IA). `false` por defecto: Place no
   * viene activo; se habilita por cuenta desde el panel superadmin. Con el flag
   * apagado, pos_api rechaza `/ai/chat` y reporta `enabled:false` en el estado;
   * el cliente oculta el botón y bloquea la ruta del chat. El acceso es por
   * negocio (todos los usuarios de la company lo comparten).
   */
  @Column({ type: 'boolean', default: false })
  ai_enabled!: boolean;

  /**
   * Slug público del catálogo web: el "nombre de usuario" que viaja en la URL
   * `/catalog/<slug>` de la landing (p. ej. `esenciaygrano`). UNA palabra en
   * minúsculas `[a-z0-9]` (sin espacios, acentos ni símbolos), UNIQUE GLOBAL
   * (índice parcial, mismo precedente que `employees.username`). `null` = el
   * negocio aún no definió su catálogo. Lo normaliza/valida el service antes de
   * escribir; el CHECK en DB es el cinturón de seguridad.
   */
  @Column({ type: 'text', nullable: true })
  catalog_slug!: string | null;

  /**
   * Gate del catálogo público. `false` por defecto: la ruta `/catalog/<slug>`
   * responde 404 aunque el slug exista. El negocio decide cuándo publicar desde
   * Configuraciones → Catálogo. Acceso por NEGOCIO (su tenant).
   */
  @Column({ type: 'boolean', default: false })
  catalog_enabled!: boolean;

  /**
   * Catálogo público: cómo se presentan los productos. `true` agrupa por
   * categoría (encabezados + sidebar de navegación en la landing); `false`
   * (default) los muestra en una sola cuadrícula plana. Es solo presentación:
   * no cambia qué productos se exponen. Lo configura el dueño desde
   * Configuraciones → Catálogo.
   */
  @Column({ type: 'boolean', default: false })
  catalog_group_by_category!: boolean;

  /**
   * Ruta en GCS de la imagen de portada (hero) del catálogo público
   * (`inventory_items/<company_id>/catalog-cover-...`, misma carpeta que el
   * inventario para reutilizar el proxy firmado). `null` = sin portada → la
   * landing muestra el hero por defecto. La URL pública se firma en lectura.
   */
  @Column({ type: 'text', nullable: true })
  catalog_cover_image!: string | null;

  /**
   * Modo del POS del negocio: `retail` (el POS de siempre, default) o
   * `restaurant` (POS dedicado a restaurantes y bares, con mesas/salones). Lo
   * cambia el panel superadmin y viaja en el perfil; el cliente Electron lo usa
   * para decidir qué ventana de POS abrir. No altera reglas de venta del backend.
   */
  @Column({
    type: 'enum',
    enum: POS_MODES,
    enumName: 'companies_pos_mode_enum',
    default: 'retail',
  })
  pos_mode!: PosMode;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  /**
   * Relación inversa hacia los usuarios de la company (siempre incluirá
   * al `owner` y, en fases siguientes, cualquier extensión). Se declara
   * con `() => User` para tolerar el import circular potencial; el
   * Architect podrá eager-load donde sea necesario.
   */
  @OneToMany(() => User, (user) => user.company)
  users!: User[];
}
