---
name: multi-tenant-rules
description: Reglas de aislamiento por company_id para el API POS multi-tenant. Cargar al diseñar una tabla, un endpoint, un guard o al auditar acceso a recursos. Cubre registro de cuenta, propagación del company_id, banderas rojas de cross-tenant.
---

# Multi-tenant rules — `company_id` como invariante absoluto

## Modelo de tenancy

- **Shared DB, discriminator column**: una sola base Postgres con `company_id` en cada tabla transaccional.
- **No** schema-per-tenant. **No** DB-per-tenant.
- **Una company por usuario** (`users.company_id` no nullable salvo para `superadmin`). Un dueño con dos negocios = dos cuentas separadas.

## Reglas innegociables

### 1. Toda tabla transaccional lleva `company_id`

```sql
company_id bigint NOT NULL REFERENCES companies(id) ON DELETE RESTRICT
```

Índice: **siempre**. La mayoría de índices compuestos empiezan por `(company_id, ...)`. Ej:

```sql
CREATE INDEX idx_sale_invoices_company_created ON sale_invoices (company_id, created_at DESC) WHERE is_deleted = false;
```

**Excepciones legítimas (sin `company_id`)**:
- `companies` (es la propia tabla)
- `users` que son `superadmin` (su `company_id` puede ser NULL)
- Tablas globales del sistema (no del negocio): logs internos, métricas API.

### 1.1 Excepciones a UNIQUE compuesto — identificadores de autenticación

La regla "todo UNIQUE incluye `company_id`" tiene **dos excepciones permitidas** y solo dos:

- **`users.email` UNIQUE GLOBAL** (Fase 0): es identificador de login del owner.
- **`employees.username` UNIQUE GLOBAL** (Fase 2): es identificador de
  autenticación de un empleado, análogo a `users.email`. El frontend de
  PlacePos envía `{ username, password }` sin tenant ID a `POST /auth/user`;
  el lookup debe ser determinista a nivel global. Si fuera unique-per-company,
  dos employees de companies distintas podrían tener el mismo username y el
  login sería ambiguo. Los owners eligen usernames únicos globalmente
  (típicamente con prefijo del negocio, ej. `kike-bodegonares`). El UNIQUE
  es PARCIAL (`WHERE username IS NOT NULL`) para permitir employees sin
  credenciales asignadas todavía.

**Defensa en profundidad anti-enumeración cross-tenant**: en ambos casos, el
servicio que consume el lookup NUNCA expone qué company posee el identificador
ni distingue entre "no existe" y "password mal". Toda falla de credenciales
devuelve el mismo `"Credenciales inválidas"` (HTTP 401).

**Cualquier otra columna que se proponga como UNIQUE GLOBAL es bloqueante**.
Debe revisarse caso por caso. La regla por defecto sigue siendo
`UNIQUE (company_id, ...)`.

### 2. Toda query filtra por `company_id`

**Repository**:
```typescript
this.repo.find({ where: { company_id, is_deleted: false } });
this.repo.findOne({ where: { id, company_id } });
```

**QueryBuilder**:
```typescript
this.repo.createQueryBuilder('s')
  .where('s.company_id = :companyId', { companyId })
  .andWhere('s.id = :id', { id })
```

**Prohibido**:
```typescript
this.repo.findOne({ where: { id } });          // ❌ IDOR
this.repo.findOneBy({ id });                    // ❌ IDOR
this.repo.delete(id);                           // ❌ IDOR
```

### 3. Propagación del `company_id`

1. JWT incluye claim `company_id` (number).
2. `JwtStrategy.validate(payload)` devuelve `{ user_id, company_id, type, account }` que NestJS pone en `request.user`.
3. Decorador `@CurrentCompany()` (custom param decorator) lee `request.user.company_id`:
   ```typescript
   @Get(':id')
   findOne(
     @Param('id', ParseIntPipe) id: number,
     @CurrentCompany() companyId: number,
   ) {
     return this.svc.findOne(id, companyId);
   }
   ```
4. Servicio **recibe `companyId` como parámetro obligatorio** y lo propaga a TODA query.

**Prohibido**:
- `@Body('company_id') companyId` — el cliente NUNCA decide la company.
- `@Query('company_id') companyId` — idem.
- `request.headers['x-company-id']` — idem.

### 4. Registro de cuenta (`POST /auth/register`)

Crea atómicamente en `dataSource.transaction(async manager => { ... })`:

1. **`Company`**: nombre, document_number, address, phone_number, etc.
2. **`User`** con:
   - `company_id = company.id`
   - `type = 'owner'`
   - `password` hasheado con `argon2id` (factor 4)
3. **Seeds esenciales para esa company** (clonar lo que hace `seedEssentials` de PlacePos):
   - `TicketSetting` para cada `TicketType` (`ORDER`, `SALE`, `CREDIT_NOTE`, `DEBIT_NOTE`, `PURCHASE`) con `current_number = 0` y prefijo por defecto.
   - `Wallet` "Efectivo" con balance 0.
   - `AppSetting` defaults: `app_color_mode = 'white'`, `pos_margins_enabled = 'false'`.
4. Genera y devuelve JWT con claims `{ user_id, company_id, name, lastname, type: 'owner', account: 'user' }` y TTL de 7 días.

Si cualquier paso falla → rollback total. No puede quedar Company sin User ni viceversa.

### 5. Empleados (`Employee`) — sub-usuarios

- Entidad **separada** de `User`. Solo el `owner` puede crearlos (guard `@Roles('owner')`).
- `Employee.company_id` se asigna **automáticamente** del owner que crea (`req.user.company_id`), nunca del payload.
- Login en `POST /auth/user`: el servicio busca primero en `users` por email/username, luego en `employees` por username. Si match en `Employee`:
  - JWT incluye `company_id = employee.company_id`, `account = 'employee'`, `type = employee.role` (manager/employee).
  - TTL 1 día.

### 6. `TicketSetting` (folios) — incremento atómico per-company

Único compuesto:
```sql
UNIQUE (company_id, ticket_type)
```

Incremento:
```sql
UPDATE ticket_settings
SET current_number = current_number + 1, updated_at = now()
WHERE company_id = $1 AND ticket_type = $2
RETURNING current_number;
```

En el servicio NestJS:
```typescript
const { raw } = await manager
  .createQueryBuilder()
  .update(TicketSetting)
  .set({ current_number: () => 'current_number + 1', updated_at: () => 'now()' })
  .where('company_id = :companyId AND ticket_type = :type', { companyId, type })
  .returning(['current_number'])
  .execute();
const newNumber = raw[0].current_number;
```

**Nunca** `findOne` + `++` + `save` — race condition garantizada.

### 7. Tests obligatorios de aislamiento

Cada test de servicio crea o usa fixture de **dos companies distintas (A y B)** y verifica:

- `service.findOne(idDeA, companyB)` → `NotFoundException`.
- `service.update(idDeA, dto, companyB)` → `NotFoundException`.
- `service.remove(idDeA, companyB)` → `NotFoundException`.
- `service.list(companyA)` no incluye nada de `companyB`.

Si cualquiera falla → bloqueante. **No se mergea.**

## Banderas rojas

Buscar con grep antes de merge:

```bash
# Queries sin company_id
grep -rn "findOne(\s*{\s*where:\s*{\s*id" src/
grep -rn "findOneBy(\s*{\s*id" src/

# Acceso a company_id del body/query
grep -rn "@Body('company_id'" src/
grep -rn "@Query('company_id'" src/

# Servicios que reciben solo id
grep -rnE "findOne\(\s*id\s*:" src/modules/*/dto src/modules/*/service.ts
```

## Casos especiales

### Superadmin

- Rol del sistema, NO de company. `users.company_id` puede ser NULL.
- Endpoints `/admin/*` solo accesibles con `@Roles('superadmin')`.
- Para operaciones cross-company, el endpoint admin **explícitamente** acepta `?company_id=X` (saltándose el JWT). Esto es la **única** excepción al "nunca confíes en query string". Y debe estar marcado con un decorador explícito como `@SuperadminCrossCompany()` para que el auditor lo detecte.

### Endpoints públicos

`@Public()` decorator marca un endpoint como sin auth:
- `POST /auth/register`
- `POST /auth/user`
- `POST /auth/logout`
- `GET /health`

Estos **no** llaman `@CurrentCompany()`. Internamente, `register` crea la company; `login` resuelve la company del usuario que está autenticándose.

### Joins entre tablas

Cuando hagas un join, asegúrate que **ambas tablas** filtren por el mismo `company_id`. Ejemplo:

```typescript
this.saleRepo.createQueryBuilder('s')
  .innerJoin('s.customer', 'c', 'c.company_id = s.company_id')
  .where('s.company_id = :companyId', { companyId })
```

Aunque la FK garantiza coherencia, el join explícito previene fugas si alguna vez se introduce un bug en otra parte.
