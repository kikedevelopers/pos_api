# POS API

Backend (API) del sistema POS (Punto de Venta). Construido con **NestJS**, **TypeScript estricto**, **PostgreSQL** y **TypeORM**. Diseñado para servir a clientes desktop (Electron) y, en el futuro, móviles.

> Este repositorio contiene solo la **infraestructura base**. Los módulos de dominio (productos, ventas, inventario, usuarios, sucursales, etc.) se añadirán en sesiones posteriores.

---

## Requisitos

- **Node.js** 20 LTS (ver `.nvmrc`)
- **pnpm** >= 8 (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Docker** + **Docker Compose** (para PostgreSQL local)

---

## Setup inicial

```bash
# 1. Asegúrate de usar Node 20
nvm use

# 2. Instala dependencias
pnpm install

# 3. Configura variables de entorno
cp .env.example .env
# (edita `.env` si necesitas cambiar credenciales)

# 4. Levanta PostgreSQL en Docker
docker compose up -d postgres

# 5. (Opcional) Levanta Adminer para inspeccionar la DB en http://localhost:8080
docker compose up -d adminer

# 6. Ejecuta migraciones (cuando existan)
pnpm migration:run

# 7. Arranca la API en modo desarrollo
pnpm start:dev
```

La API quedará disponible en `http://localhost:3000/api/v1` y Swagger en `http://localhost:3000/api/v1/docs`.

---

## Scripts disponibles

| Script                       | Descripción                                                            |
| ---------------------------- | ---------------------------------------------------------------------- |
| `pnpm start`                 | Arranca la app en modo producción (requiere `pnpm build` previo).      |
| `pnpm start:dev`             | Modo desarrollo con watch.                                             |
| `pnpm start:debug`           | Modo debug con watch (puerto 9229).                                    |
| `pnpm start:prod`            | Ejecuta `dist/main.js` directamente.                                   |
| `pnpm build`                 | Compila TypeScript a `dist/`.                                          |
| `pnpm lint`                  | ESLint con `--fix`.                                                    |
| `pnpm lint:check`            | ESLint sin auto-fix (CI).                                              |
| `pnpm format`                | Prettier sobre `src/` y `test/`.                                       |
| `pnpm test`                  | Tests unitarios.                                                       |
| `pnpm test:watch`            | Tests unitarios en modo watch.                                         |
| `pnpm test:cov`              | Tests con coverage.                                                    |
| `pnpm test:e2e`              | Tests end-to-end.                                                      |
| `pnpm migration:generate`    | Genera una nueva migración a partir del diff de entidades.             |
| `pnpm migration:create`      | Crea una migración vacía (cambios manuales).                           |
| `pnpm migration:run`         | Aplica las migraciones pendientes.                                     |
| `pnpm migration:revert`      | Revierte la última migración aplicada.                                 |
| `pnpm migration:show`        | Muestra el estado de las migraciones.                                  |
| `pnpm db:seed`               | Placeholder — se implementará al añadir entidades.                     |

---

## Estructura de carpetas

```
src/
├── main.ts                      # Bootstrap: pipes, helmet, CORS, Swagger
├── app.module.ts                # Módulo raíz
├── app.controller.ts            # GET / con info básica
├── app.service.ts
├── common/
│   ├── filters/                 # AllExceptionsFilter
│   ├── interceptors/            # TransformInterceptor (opt-in)
│   ├── decorators/              # Decoradores compartidos
│   ├── guards/                  # Guards compartidos
│   ├── pipes/                   # Pipes compartidos
│   └── dto/                     # DTOs compartidos (paginación, etc.)
├── config/
│   ├── configuration.ts         # Agrupa todos los configs
│   ├── app.config.ts            # Config de aplicación
│   ├── database.config.ts       # Config de base de datos
│   └── validation.schema.ts     # Esquema Joi de envs
├── database/
│   ├── database.module.ts       # TypeOrmModule.forRootAsync
│   ├── data-source.ts           # DataSource para el CLI de TypeORM
│   └── migrations/              # Migraciones SQL/TS
├── health/
│   ├── health.module.ts
│   └── health.controller.ts     # /health, /health/live, /health/ready
└── modules/                     # Módulos de dominio (se añadirán aquí)
```

---

## Cómo crear migraciones

TypeORM v0.3 requiere apuntar al `DataSource` correcto.

### Generar una migración a partir del diff de entidades

```bash
pnpm migration:generate src/database/migrations/NombreDescriptivo
```

### Crear una migración vacía (cambios manuales)

```bash
pnpm migration:create src/database/migrations/NombreDescriptivo
```

### Aplicar / revertir / inspeccionar

```bash
pnpm migration:run
pnpm migration:revert
pnpm migration:show
```

> **Importante:** En producción, `synchronize` está deshabilitado (`DB_SYNCHRONIZE=false`). Todo cambio de esquema debe ir por migración.

---

## Endpoints iniciales

| Método | Ruta                  | Descripción                                |
| ------ | --------------------- | ------------------------------------------ |
| GET    | `/api/v1/`            | Info básica (nombre, versión, env, uptime) |
| GET    | `/api/v1/health`      | Health check completo (DB + memoria)       |
| GET    | `/api/v1/health/live` | Liveness probe                             |
| GET    | `/api/v1/health/ready`| Readiness probe                            |
| GET    | `/api/v1/docs`        | Swagger / OpenAPI (si `SWAGGER_ENABLED=true`) |

---

## Variables de entorno

Ver [`.env.example`](./.env.example) para la lista completa con comentarios. Todas las variables se validan con **Joi** al arrancar — si falta alguna o es inválida, la aplicación falla de inmediato.

---

## Docker

- `Dockerfile` multi-stage (deps → builder → runner) con usuario no-root.
- `docker-compose.yml` solo levanta **PostgreSQL** y **Adminer** para desarrollo local.
- Para desarrollo, el desarrollador corre `pnpm start:dev` en el host, conectando a la DB del compose.
- El servicio de la API en Docker se añadirá cuando preparemos el stack de despliegue completo.

---

## Stack técnico

- NestJS 10
- TypeScript estricto
- PostgreSQL 16 + TypeORM 0.3
- Pino (logger estructurado) via `nestjs-pino`
- Joi (validación de envs)
- class-validator + class-transformer (validación de DTOs)
- Helmet, CORS, @nestjs/throttler (seguridad)
- @nestjs/terminus (health checks)
- @nestjs/swagger (OpenAPI)
