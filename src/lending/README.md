# Contexto de préstamos (`src/lending`)

Todo lo del tipo de negocio **prestamista**: planes de préstamo y préstamos. Vive
aislado del punto de venta porque se va a extraer como **API independiente**.

## Estructura

| Carpeta | Qué contiene | Depende de |
|---|---|---|
| `domain/` | Reglas puras: planes (`loan-plan-rules`), cuota (`loan-amounts`), fecha de inicio | Solo librerías (`big.js`, `dayjs`) |
| `ports/` | Contratos de lo que préstamos necesita del exterior: clientes, tesorería, tenant y la transacción compartida | Nada |
| `loan-plans/`, `loans/` | Módulos Nest (controller → service → actions), entidades y DTOs | `domain`, `ports`, núcleo compartido |
| `guards/` | `LenderModeGuard` (403 si la company no es prestamista), vía el puerto de tenant | `ports` |
| `integration/pos/` | **Adaptadores** que implementan los puertos con los módulos del POS | POS (único lugar permitido) |
| `database/migrations/` | Migraciones de las tablas y conceptos de préstamos | — |

`LendingModule` es el único punto de entrada; el POS solo lo registra en `AppModule`.

## Reglas (las verifica `__tests__/boundaries.spec.ts`)

1. Solo `integration/pos/` importa `@/modules/*` (el POS).
2. Del núcleo compartido (`@/common`) solo se usan decoradores, tipos, utilidades,
   `pos-mode` y el `AdminLevelGuard`.
3. Ningún archivo del POS importa algo de `src/lending` (salvo `AppModule`).
4. Los adaptadores se usan solo a través de `PosLendingIntegrationModule`.
5. Las migraciones de préstamos viven en `database/migrations/` de este contexto.

Las entidades guardan `company_id` y `customer_id` como columnas, **sin relaciones
TypeORM** a entidades del POS (las FKs siguen en la base). El nombre del cliente se
pide al puerto de clientes.

## Qué queda en el núcleo (a propósito)

- `companies.pos_mode = 'lender'` y su migración (`add-lender-pos-mode`): el tipo de
  negocio es un atributo del tenant que administra el panel superadmin.
- Los valores `LOAN_DISBURSEMENT` de `movement_concept` y `cash_register_log_type`:
  son de la tesorería del POS (los usa solo el adaptador de tesorería), aunque su
  migración vive aquí porque la pidió préstamos.
- Autenticación y permisos (`JwtAuthGuard`, `AdminLevelGuard`, `RolesModule`): núcleo
  compartido, llega por el módulo de integración.

## Cómo extraerlo como API aparte

1. Copiar `src/lending` al nuevo servicio junto con el núcleo compartido que usa.
2. Reemplazar `integration/pos/` por adaptadores HTTP contra la API del POS que
   implementen los mismos puertos (`ports/`). Las actions no cambian.
3. El desembolso hoy es atómico porque comparte transacción (`LendingTx`) con la
   tesorería. Separados, pasa a ser un flujo entre servicios (outbox o compensación):
   solo cambia el adaptador de tesorería.
4. Las FKs a `companies` y `customers` pasan a ser referencias lógicas, y las
   migraciones de `database/migrations/` crean el esquema del nuevo servicio.
