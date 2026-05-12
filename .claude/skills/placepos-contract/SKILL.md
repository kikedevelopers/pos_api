---
name: placepos-contract
description: Contrato HTTP exacto que este API debe espejar byte-por-byte respecto a PlacePos. Endpoints, wrapper de respuesta, formato de error, JWT, status codes y reglas de evolución. Cargar al diseñar un endpoint nuevo o alterar uno existente.
---

# Contrato HTTP — espejo de PlacePos

Fuente canónica: `/Volumes/KiKe 1/development/placepos/src/main/server/routes/*.routes.ts`.

**El cliente Electron de PlacePos en modo CLOUD apunta a este API sin tocar el frontend.** Cada endpoint debe ser indistinguible del servidor Express local de PlacePos en path, método, payload y respuesta.

## Prefijo de versión

Las rutas se montan bajo `/api/v1` (configurable vía `API_PREFIX`). El cliente PlacePos concatena el prefijo automáticamente; el frontend no se reescribe.

Ejemplo: `POST /sales` en PlacePos → `POST /api/v1/sales` en este API.

## Wrapper de respuesta

### Éxito

```json
{
  "success": true,
  "payload": <T>
}
```

`<T>` puede ser cualquier shape: objeto, array, primitivo. Si hay paginación, el shape de paginación va dentro de `payload` (raro en PlacePos).

### Error

```json
{
  "success": false,
  "error": "Mensaje legible en español"
}
```

Algunos endpoints añaden `payload` con código:

```json
{
  "success": false,
  "error": "Ya existe una venta con ese ticket_number",
  "payload": { "code": "DUPLICATE_TICKET_NUMBER" }
}
```

### Implementación

- **`ResponseWrapperInterceptor`** global: envuelve cualquier valor del controller en `{ success: true, payload: ... }`.
- **`AllExceptionsFilter`** global: convierte `HttpException` y errores no controlados al formato de error.
- Controllers y servicios devuelven datos crudos. **Nunca** envuelven manualmente.

## Status codes

| Código | Cuándo |
|---|---|
| 200 | GET ok, PUT exitoso, POST de acción no creadora |
| 201 | POST que crea recurso |
| 204 | DELETE sin body |
| 400 | Validación de payload (ValidationPipe) |
| 401 | Sin token / token inválido / token expirado |
| 403 | Rol insuficiente / acceso cross-tenant |
| 404 | Recurso no existe (o existe en otra company) |
| 409 | Conflicto (duplicado, estado inconsistente) |
| 422 | Lógica de negocio rechaza |
| 429 | Rate limit |
| 500 | Error interno (loguea stack trace; no expone al cliente) |

## Auth

### Endpoints públicos

Sin `Authorization` header:

- `POST /auth/user` — login (User o Employee)
- `POST /auth/register` — **NUEVO en cloud**, no existe en PlacePos local
- `POST /auth/logout` — stateless; el frontend descarta el token
- `GET /health` — healthcheck

### Login (`POST /auth/user`)

Request:

```json
{
  "username": "kike@ares.pos",
  "password": "..."
}
```

Para User: `username` = email. Para Employee: `username` = `employees.username`.

Response 200:

```json
{
  "success": true,
  "payload": {
    "access_token": "eyJhbGc...",
    "user": {
      "id": 1,
      "name": "Kike",
      "lastname": "Pacheco",
      "email": "kike@ares.pos",
      "type": "owner"
    }
  }
}
```

Para Employee, `payload.user.type` puede ser `manager` o `employee`. `email` puede ser null.

Response 401:

```json
{
  "success": false,
  "error": "Credenciales inválidas"
}
```

Rate limit específico: **10 intentos/minuto por IP**.

### Registro (`POST /auth/register`) — solo CLOUD

Request:

```json
{
  "user": {
    "name": "Kike",
    "lastname": "Pacheco",
    "email": "kike@ares.pos",
    "password": "..."
  },
  "company": {
    "name": "Bodegón Ares",
    "document_number": "J-12345678-9",
    "address": "Caracas, Venezuela",
    "phone_number": "+58..."
  }
}
```

Response 201: mismo shape que login. Internamente crea User+Company+seeds atómicamente (ver skill `multi-tenant-rules`).

Respuesta 409 si el email ya existe:

```json
{
  "success": false,
  "error": "Ya existe una cuenta con ese email",
  "payload": { "code": "EMAIL_TAKEN" }
}
```

### Logout (`POST /auth/logout`)

Sin payload. Response 200:

```json
{
  "success": true,
  "payload": null
}
```

Como JWT es stateless, no hay invalidación server-side. El cliente descarta el token. (Futuro: blacklist Redis si se necesita.)

### Me / Profile

- `GET /auth/me` — devuelve `payload: { id, name, lastname, email, type }` del usuario del JWT.
- `GET /auth/profile` — devuelve `payload: { user: {...}, company: {...} }` con datos completos.

### JWT — claims

```json
{
  "user_id": 1,
  "company_id": 42,
  "name": "Kike",
  "lastname": "Pacheco",
  "type": "owner",
  "account": "user",
  "iat": 1715520000,
  "exp": 1716124800
}
```

- `account`: `"user"` (entidad `User`) o `"employee"` (entidad `Employee`).
- `type`: `superadmin | owner | manager | employee`.

TTL:
- `owner | superadmin`: **7 días**
- `manager | employee`: **1 día**

Header:

```
Authorization: Bearer <JWT>
```

## Inventario de rutas (las 26 que el API debe exponer)

Lista canónica:

| Prefijo | Archivo PlacePos | Endpoints |
|---|---|---|
| `/auth` | `auth.routes.ts` | login, me, profile, logout |
| `/sales` | `sales.routes.ts` | CRUD ventas, void, consolidated, credit-note |
| `/purchases` | `purchases.routes.ts` | CRUD compras, receive, pagos |
| `/customers` | `customers.routes.ts` | CRUD + analytics + historial |
| `/employees` | `employees.routes.ts` | CRUD empleados + credentials + toggle-login |
| `/suppliers` | `suppliers.routes.ts` | CRUD + analytics + archive |
| `/inventory` | `inventory.routes.ts` | CRUD productos + bulk + show-in-pos |
| `/banks` | `banks.routes.ts` | CRUD bancos |
| `/wallets` | `wallets.routes.ts` | CRUD billeteras |
| `/cash-register` | `cash-register.routes.ts` | balance + logs |
| `/credit-notes` | `credit-notes.routes.ts` | get by invoice |
| `/expenses` | `expenses.routes.ts` | CRUD gastos + payment-methods + void |
| `/financial-movements` | `financial-movements.routes.ts` | listar por cuenta |
| `/companies` | `companies.routes.ts` | get + update |
| `/accounts` | `accounts.routes.ts` | transfer-destinations + transfer |
| `/payments` | `payments.routes.ts` | registrar pago de crédito |
| `/credits` | `credits.routes.ts` | crear crédito a venta |
| `/packagings` | `packagings.routes.ts` | CRUD empaques + archive |
| `/app-settings` | `app-settings.routes.ts` | color-mode + pos-margins |
| `/app-alerts` | `app-alerts.routes.ts` | CRUD + unread-count + read-all |
| `/alert-configs` | `alert-configs.routes.ts` | CRUD + run-now |
| `/backup` | `backup.routes.ts` | CRUD backups + download |
| `/dashboard` | `dashboard.routes.ts` | performance + today + expense-impact + top-products + break-even |
| `/reports` | `reports.routes.ts` | daily-closure + credits |
| `/pos-reports` | `pos-reports.routes.ts` | sales + dashboard-sales |
| `/pos-data` | `pos-data.routes.ts` | items + customers + payment-banks + transfer-destinations + transfer-cash |

Para cada endpoint nuevo: **abrir el archivo correspondiente de PlacePos** y replicar path, método, payload, response shape. Si hay duda, el código de PlacePos es la verdad.

## Paginación

PlacePos NO usa cursor ni offset/page estándar. Usa:

- Sin paginación (retorna lista completa): `GET /banks`, `GET /wallets`, `GET /packagings`.
- `?limit=N` (últimos N): `GET /sales?limit=20`.
- `?from=YYYY-MM-DD&to=YYYY-MM-DD` (rango temporal): reportes, dashboard.
- `?search=...&date_from=...&date_to=...`: `GET /expenses`, `GET /pos-reports/sales`.

Si añades paginación nueva: documenta como extensión opt-in que el frontend puede ignorar. Default = comportamiento PlacePos.

## Mensajes de error (mantener idénticos cuando aplique)

El frontend de PlacePos puede branchear lógica por substring. Mantén consistencia:

| Caso | Mensaje |
|---|---|
| Sin token | `"Token no proporcionado"` |
| Token inválido | `"Token inválido o expirado"` |
| Credenciales mal | `"Credenciales inválidas"` |
| Rol insuficiente | `"Usuario sin permisos para esta acción"` |
| Recurso inexistente | `"El producto no existe"` / `"La venta no existe"` / etc. |
| Stock insuficiente | `"Stock insuficiente"` |
| Venta ya anulada | `"La venta ya fue anulada"` |
| Email duplicado en registro | `"Ya existe una cuenta con ese email"` |

## Funcionalidad que NO migra tal cual

| Endpoint PlacePos | Estrategia cloud |
|---|---|
| `POST /backup` (ZIP local en `app.getPath('userData')`) | Reemplazar por backup automático a object storage (S3 / R2) (post-MVP). Por ahora: ruta existe pero devuelve 503 con mensaje "Función no disponible en modo CLOUD". |
| `GET /backup/:id/download` | Idem. |
| `GET /backup` | Devuelve lista vacía hasta implementar cloud storage. |
| Configuración de impresora local (`TicketSetting` físico) | Las dimensiones de papel y configuración de impresora se mantienen en `AppSetting`. El cliente Electron decide cómo imprimir localmente. |

## Reglas de evolución

- **No** renombres campos en DTOs existentes.
- **No** elimines campos en respuestas.
- **Sí** puedes añadir campos opcionales nuevos (el frontend los ignora).
- Cambios breaking → `/api/v2/...`.
- Cualquier divergencia respecto al contrato PlacePos se documenta en este archivo con justificación.

## Cómo verificar paridad

Antes de declarar un módulo terminado:

1. Abre el archivo de ruta correspondiente de PlacePos.
2. Para cada endpoint, compara:
   - Path exacto (incluyendo `:param`).
   - Método HTTP.
   - Shape de request body (nombres de campos, tipos).
   - Shape de response (nombres, tipos, anidación).
   - Códigos de status para éxito y errores comunes.
3. Si algo difiere: o ajustas el API, o lo documentas explícitamente como divergencia justificada.
