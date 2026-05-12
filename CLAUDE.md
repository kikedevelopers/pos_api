# POS API — Reglas del proyecto

> Este archivo se carga automáticamente en cada sesión de Claude que opere sobre este repo. Las reglas aquí escritas son innegociables salvo que el usuario las cambie explícitamente. Las skills referenciadas viven en `.claude/skills/`.

## 1. Qué es este proyecto

API NestJS **multi-tenant en la nube** que **espeja el contrato HTTP** del proyecto PlacePos (`/Volumes/KiKe 1/development/placepos`). PlacePos es un POS Electron que opera en dos modos:

- **Modo servidor local**: Electron levanta un Express en puerto 3800 sirviendo PostgreSQL local. Una base por instalación.
- **Modo CLOUD** (lo que habilita este API): Electron apunta su cliente HTTP a este API. Una sola base, multi-negocio, aislada por `company_id`.

Para que el cliente PlacePos pueda alternar entre los dos modos **sin tocar el frontend**, este API debe ser indistinguible del servidor Express de PlacePos en rutas, métodos, payloads y respuestas. Lo único nuevo es `POST /auth/register` (crear cuenta + negocio).

## 2. Reglas innegociables

### 2.1 Contrato HTTP idéntico a PlacePos

- Rutas, métodos, payloads de request y shape de response **coinciden byte por byte** con `/Volumes/KiKe 1/development/placepos/src/main/server/routes/*.routes.ts`.
- Wrapper de respuesta: `{ success: boolean, payload: T }` para éxitos; `{ success: false, error: string, payload?: { code?: string } }` para errores. **NO usar `{ data, meta }`.**
- Status codes: 200 GET/PUT, 201 POST que crea, 204 DELETE, 400 validación, 401 sin token, 403 rol insuficiente o cross-tenant, 404 not found, 409 conflicto, 422 lógica de negocio rechaza, 429 rate limit, 500 error interno.
- Cambios al contrato son breaking → versionado `/api/v2/...`. **No** se modifica un endpoint v1 existente.
- Referencia completa: skill `placepos-contract`.

### 2.2 Multi-tenancy estricta

- Toda tabla transaccional lleva `company_id bigint NOT NULL` con FK a `companies` e índice.
- Toda query filtra por `company_id`. `findOne({ where: { id } })` sin company_id está **prohibido** — es IDOR.
- JWT incluye claim `company_id`. Decorador `@CurrentCompany()` lo extrae al controller. El servicio recibe `companyId` como parámetro y lo propaga a cada query.
- Un usuario pertenece a **una sola** company. No multi-empresa con un solo login.
- Registro: `POST /auth/register` crea atómicamente User (rol `owner`) + Company + seeds esenciales (TicketSettings, Wallet "Efectivo", AppSettings).
- Detalle: skill `multi-tenant-rules`.

### 2.3 IDs públicos

- PlacePos usa `bigserial` autoincremental. **Lo mantenemos.**
- Los `:id` en URLs son enteros. Pero **siempre** se valida `AND company_id = $current`.
- UUID solo para el campo `uuid` de idempotencia en `sale_payments` y `purchase_payments` (mismo que en PlacePos).

### 2.4 Soft delete

- Convención PlacePos: `is_deleted boolean NOT NULL DEFAULT false`. No `deleted_at`.
- Algunas entidades usan `is_archived` con la misma semántica (Bank, Wallet, Supplier, Packaging, Employee, Expense).
- Filtro implícito en queries normales: `WHERE is_deleted = false` o `WHERE is_archived = false` según corresponda.

### 2.5 Tipos de datos

- Dinero: `numeric(15, 2)`. Cantidades y márgenes: `numeric(15, 4)`. Nunca `float`/`real`/`double precision`.
- Fechas: `timestamptz` siempre.
- Enums: tipo `enum` nativo Postgres + `@Column({ type: 'enum', enum: ... })` en TypeORM.
- Texto: `text` por defecto.
- JSON: `jsonb` siempre, nunca `json`.
- Cálculos: **Big.js** obligatorio para todo lo monetario. Detalle: skill `financial-precision`.

### 2.6 Idempotencia

- Columnas `uuid` (unique, per-company) en pagos: cliente envía v4 para que un reintento no duplique cobro.
- Endpoints de pago: si llega `uuid` ya procesado, devolver 200 con el pago existente. **No** 409.

### 2.7 Roles

| Rol | Origen | Alcance |
|---|---|---|
| `superadmin` | Asignado manual en DB | Cross-company. Endpoints `/admin/*`. No se llega vía registro. |
| `owner` | Creado por `POST /auth/register` | Toda su company. Único que crea empleados. |
| `manager` | Empleado creado por owner | Toda su company excepto admin de empresa. |
| `employee` | Empleado creado por owner | Operación de POS (ventas, caja). |

- TTL JWT: 7 días para `owner | superadmin`, 1 día para `manager | employee`.
- `User` vs `Employee`: son dos entidades. `User` representa al dueño (uno por company). `Employee` representa al personal contratado. Ambos pueden hacer login en `POST /auth/user`; el servicio decide cuál.

### 2.8 Clasificación de facturas y notas

- Tickets: `ORDER` (pedido, editable, anulable directo) vs `SALE` (venta confirmada, solo anulable vía nota crédito).
- Notas: `CREDIT` (reduce) o `DEBIT` (aumenta), con `operation_type` `FULL_VOID` / `PARTIAL_VOID` / `ADDITION`.
- Total consolidado = `sale.total - Σ(CREDIT) + Σ(DEBIT)` calculado con Big.js.
- Folios per-company: `UNIQUE(company_id, ticket_type)` en `ticket_settings`; incremento atómico vía `UPDATE ... RETURNING`.
- Detalle: skill `invoice-and-notes`.

## 3. Stack y convenciones

- **NestJS 10.4.15** + TypeScript estricto + **pnpm**.
- **PostgreSQL 16** + **TypeORM 0.3.20** con `synchronize: false`. Migraciones obligatorias en `src/database/migrations/`.
- **Auth**: `@nestjs/jwt` + Passport JWT strategy. Hash de password con `argon2`.
- **Validación**: `class-validator` + `class-transformer` + `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`, `transform`).
- **Logger**: `nestjs-pino`. **Docs**: `@nestjs/swagger`. **Rate limit**: `@nestjs/throttler` (10/min en login, 100/min global).
- **Path alias**: `@/` apunta a `src/`.
- Idioma: código y nombres en inglés. Comentarios en español **solo** cuando el "por qué" no sea obvio.
- Nada de `any` salvo justificación documentada en línea.

## 4. Estructura de directorios

```
src/
├── main.ts
├── app.module.ts
├── common/
│   ├── decorators/
│   │   ├── current-user.decorator.ts
│   │   ├── current-company.decorator.ts
│   │   ├── public.decorator.ts
│   │   └── roles.decorator.ts
│   ├── filters/
│   │   └── all-exceptions.filter.ts
│   ├── interceptors/
│   │   └── response-wrapper.interceptor.ts
│   ├── guards/
│   │   ├── jwt-auth.guard.ts
│   │   └── roles.guard.ts
│   ├── dto/
│   │   └── pagination-query.dto.ts
│   └── utils/
│       ├── precision.ts            # Big.js helpers (espejo de PlacePos)
│       └── numeric-transformer.ts
├── database/
│   ├── data-source.ts
│   └── migrations/
├── modules/
│   ├── auth/
│   ├── companies/
│   ├── users/
│   ├── employees/
│   ├── customers/
│   ├── suppliers/
│   ├── products/
│   ├── packagings/
│   ├── sales/
│   ├── credit-notes/
│   ├── purchases/
│   ├── banks/
│   ├── wallets/
│   ├── cash-register/
│   ├── expenses/
│   ├── financial-movements/
│   ├── ticket-settings/
│   ├── app-settings/
│   ├── app-alerts/
│   ├── alert-configs/
│   ├── dashboard/
│   ├── reports/
│   ├── pos-reports/
│   ├── pos-data/
│   ├── accounts/
│   ├── payments/
│   └── credits/
└── health/
```

Cada módulo sigue la forma:
```
modules/<dominio>/
├── dto/
├── entities/
├── <dominio>.controller.ts
├── <dominio>.service.ts
├── <dominio>.module.ts
└── __tests__/
```

## 5. Subagentes — cuándo delegar

Estos viven en `.claude/agents/`. **Invócalos proactivamente** según la tarea:

| Tarea | Subagente |
|---|---|
| Diseñar/implementar endpoint, DTO, controller, service, módulo | `nestjs-architect` |
| Diseñar tabla, migración, índice; optimizar query; sospecha de N+1 | `postgres-dba` |
| Auditar seguridad de un módulo recién implementado antes de merge | `security-auditor` |

Workflow estándar para implementar un dominio:
1. **Diseño**: `postgres-dba` propone tabla + migración. `nestjs-architect` propone DTOs y firma de servicio.
2. **Implementación**: `nestjs-architect` escribe entidad, servicio, controller, módulo, tests.
3. **Refactor**: `postgres-dba` revisa queries generadas y propone optimizaciones.
4. **Aprobación**: `security-auditor` audita y firma con APROBADO / APROBADO CON CONDICIONES / BLOQUEADO.

## 6. Skills — cuándo cargar

Estos viven en `.claude/skills/<name>/SKILL.md`. Carga el relevante al entrar en su dominio:

| Skill | Cuándo |
|---|---|
| `multi-tenant-rules` | Diseñar tabla, endpoint, guard, o auditar acceso a recursos |
| `invoice-and-notes` | Trabajar en ventas, anulaciones, notas crédito/débito, reportes |
| `financial-precision` | Cualquier servicio que toque dinero, IVA, márgenes, totales |
| `placepos-contract` | Diseñar un endpoint nuevo o alterar uno existente |

## 7. Comandos útiles

```bash
pnpm install                          # instalar deps
docker compose up -d                  # levantar Postgres + Adminer
pnpm start:dev                        # API en watch mode
pnpm lint                             # ESLint
pnpm test                             # Jest unit tests
pnpm test:e2e                         # Jest e2e
pnpm build                            # build de producción

# TypeORM CLI
pnpm migration:create src/database/migrations/<nombre>
pnpm migration:generate src/database/migrations/<nombre>
pnpm migration:run
pnpm migration:revert
pnpm migration:show
```

## 8. Reglas anti-bug específicas del dominio

1. **Nunca** sumes/multipliques `number` directo en lógica financiera. Siempre `toBig()` primero.
2. **Nunca** uses `findOne({ where: { id } })` sin `company_id`. Es vulnerabilidad cross-tenant.
3. **Nunca** habilites `synchronize: true`, ni siquiera en dev.
4. **Nunca** confíes en `?company_id=X` del query string. El `company_id` viene del JWT, no del cliente.
5. **Nunca** acepts `@Body() body: any`. Siempre DTO con validación.
6. **Nunca** expongas `password_hash`, JWT secrets, ni columnas de auditoría sensibles en respuestas.
7. **Nunca** modifiques el contrato HTTP de un endpoint v1 existente — versiona.
8. **Siempre** envuelve operaciones multi-paso (venta+pago+stock+caja) en `dataSource.transaction()`.
9. **Siempre** incrementa contadores de folios atómicamente (`UPDATE ... RETURNING`).
10. **Siempre** registra eventos críticos en log (login fallido, anulación de venta, transferencia entre cuentas).
