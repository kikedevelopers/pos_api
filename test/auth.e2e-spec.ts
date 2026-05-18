import { HttpStatus, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';

// IMPORTANTE: NO importamos `AppModule` ni nada de `src/` a nivel de módulo.
// `ConfigModule.forRoot` corre al cargar `AppModule` y valida env (Joi); si
// el entorno del runner no tiene las vars de DB y JWT_SECRET, el import
// explota antes de que Jest pueda skipear el describe. Resolvemos `AppModule`
// dinámicamente dentro de `beforeAll` SOLO cuando RUN_AUTH_E2E=1.

/**
 * E2E del módulo `auth`.
 *
 * REQUISITOS PARA CORRER ESTOS TESTS:
 *   1. Postgres corriendo y accesible con las credenciales de `.env` (o
 *      variables exportadas en el entorno). Típicamente:
 *        docker compose up -d postgres
 *   2. Migraciones aplicadas:
 *        pnpm migration:run
 *   3. `JWT_SECRET` >= 64 chars en el entorno del proceso de tests.
 *   4. Variable de opt-in: `RUN_AUTH_E2E=1 pnpm test:e2e`.
 *
 * Por qué el opt-in:
 *   El pipeline de CI no tiene Postgres garantizado; ejecutar estos tests
 *   sin DB rompería el `pnpm test:e2e`. Cuando llegue testcontainers o un
 *   docker-in-CI estable, se quita el `describeIf` y se hace incondicional.
 *
 * Cobertura (13 casos):
 *   1. register (201) feliz path.
 *   2. register (409) email tomado → payload.code = EMAIL_TAKEN.
 *   3. register (400) password de 4 chars.
 *   4. login (200) creds válidas.
 *   5. login (401) password mal.
 *   6. login (401) usuario inexistente — mismo mensaje genérico.
 *   7. me (200) Bearer válido.
 *   8. me (401) sin Bearer.
 *   9. profile (200) Bearer válido — company.name match.
 *  10. logout (200) payload null.
 *  11. login employee (200) creds válidas → payload.user.type === 'employee'.
 *  12. login employee (401) password mal — mismo mensaje genérico.
 *  13. login manager (200) creds válidas → payload.user.type === 'employee'
 *      LITERAL (paridad PlacePos byte-por-byte; blinda contra regresión CRIT-1).
 */

const SHOULD_RUN = process.env.RUN_AUTH_E2E === '1';
const describeIf = SHOULD_RUN ? describe : describe.skip;

interface SuccessEnvelope<T> {
  success: true;
  payload: T;
}

interface ErrorEnvelope {
  success: false;
  error: string;
  payload?: { code?: string; details?: unknown };
}

interface AuthPayload {
  access_token: string;
  user: {
    id: number;
    name: string;
    lastname: string;
    email: string;
    type: string;
  };
}

interface ProfilePayload {
  company_profile: {
    primary: { id: number; name: string; is_branch: boolean; balance: number } | null;
    companies: Array<{ id: number; name: string }>;
  };
  user_profile: AuthPayload['user'] & { created_at: string };
}

/**
 * Genera un email único por corrida para no chocar con datos previos del
 * Postgres de dev. El tester puede limpiar la tabla `users` y `companies`
 * a mano si lo desea, pero los tests no lo asumen.
 */
const uniqueSuffix = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describeIf('Auth (e2e)', () => {
  let app: INestApplication;
  let httpServer: Server;

  // Datos compartidos entre tests para evitar 60 registros por corrida.
  // Shape PLANO — paridad cliente PlacePos en modo CLOUD.
  const validRegister = {
    name: 'E2E',
    lastname: 'Tester',
    email: `e2e-${uniqueSuffix()}@pos.test`,
    password: 'PasswordSeguro123!',
    company_name: `E2E Co ${uniqueSuffix()}`,
  };
  let issuedToken: string | undefined;

  beforeAll(async () => {
    // Resolución dinámica para evitar que `ConfigModule` valide env al
    // importar el módulo (rompería el runner cuando los tests están skipped).
    const { AppModule } = (await import('@/app.module')) as {
      AppModule: new (...args: unknown[]) => unknown;
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Replicamos el bootstrap mínimo: ValidationPipe + filter + interceptor
    // ya vienen registrados como providers globales en AppModule, salvo el
    // ValidationPipe que en producción se aplica desde main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    // El prefix /api/v1 es responsabilidad de main.ts; aquí lo añadimos a
    // mano para que las rutas del test coincidan con el contrato.
    app.setGlobalPrefix('api/v1');
    await app.init();
    httpServer = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // ---------- 1) register feliz ----------
  it('POST /api/v1/auth/register (201) crea owner+company y retorna access_token', async () => {
    const response = await request(httpServer).post('/api/v1/auth/register').send(validRegister);

    expect(response.status).toBe(HttpStatus.CREATED);
    const body = response.body as SuccessEnvelope<AuthPayload>;
    expect(body.success).toBe(true);
    expect(typeof body.payload.access_token).toBe('string');
    expect(body.payload.access_token.length).toBeGreaterThan(20);
    expect(body.payload.user.email).toBe(validRegister.email);
    expect(body.payload.user.type).toBe('owner');
    issuedToken = body.payload.access_token;
  });

  // ---------- 2) register con email tomado ----------
  it('POST /api/v1/auth/register (409) con email ya tomado → payload.code = EMAIL_TAKEN', async () => {
    const response = await request(httpServer)
      .post('/api/v1/auth/register')
      .send({ ...validRegister, company_name: 'Other Co' });

    expect(response.status).toBe(HttpStatus.CONFLICT);
    const body = response.body as ErrorEnvelope;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Ya existe una cuenta con ese email');
    expect(body.payload?.code).toBe('EMAIL_TAKEN');
  });

  // ---------- 3) register con password corto ----------
  it('POST /api/v1/auth/register (400) password < 8 chars', async () => {
    const response = await request(httpServer)
      .post('/api/v1/auth/register')
      .send({
        ...validRegister,
        email: `short-${uniqueSuffix()}@pos.test`,
        password: 'abcd',
      });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    const body = response.body as ErrorEnvelope;
    expect(body.success).toBe(false);
  });

  // ---------- 4) login feliz ----------
  it('POST /api/v1/auth/user (200) con credenciales válidas', async () => {
    const response = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username: validRegister.email, password: validRegister.password });

    expect(response.status).toBe(HttpStatus.OK);
    const body = response.body as SuccessEnvelope<AuthPayload>;
    expect(body.success).toBe(true);
    expect(typeof body.payload.access_token).toBe('string');
    expect(body.payload.user.email).toBe(validRegister.email);
    issuedToken = body.payload.access_token;
  });

  // ---------- 5) login password mal ----------
  it('POST /api/v1/auth/user (401) password incorrecto', async () => {
    const response = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username: validRegister.email, password: 'wrong-password-zzz' });

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    const body = response.body as ErrorEnvelope;
    expect(body.error).toBe('Credenciales inválidas');
  });

  // ---------- 6) login usuario inexistente ----------
  it('POST /api/v1/auth/user (401) usuario inexistente — mismo mensaje', async () => {
    const response = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username: `nobody-${uniqueSuffix()}@pos.test`, password: 'whatever-123' });

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    const body = response.body as ErrorEnvelope;
    expect(body.error).toBe('Credenciales inválidas');
  });

  // ---------- 7) /me con Bearer válido ----------
  it('GET /api/v1/auth/me (200) con Bearer válido', async () => {
    expect(issuedToken).toBeDefined();
    const response = await request(httpServer)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${issuedToken ?? ''}`);

    expect(response.status).toBe(HttpStatus.OK);
    // Paridad PlacePos local (`auth.routes.ts:193`): el payload es
    // `{ user: { id, name, type, ... } }`, no el snapshot plano.
    const body = response.body as SuccessEnvelope<{ user: AuthPayload['user'] }>;
    expect(body.payload.user.email).toBe(validRegister.email);
    expect(body.payload.user.type).toBe('owner');
  });

  // ---------- 8) /me sin Bearer ----------
  it('GET /api/v1/auth/me (401) sin Bearer', async () => {
    const response = await request(httpServer).get('/api/v1/auth/me');
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    const body = response.body as ErrorEnvelope;
    expect(body.success).toBe(false);
  });

  // ---------- 9) /profile con Bearer válido ----------
  it('GET /api/v1/auth/profile (200) con Bearer válido — company.name match', async () => {
    expect(issuedToken).toBeDefined();
    const response = await request(httpServer)
      .get('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${issuedToken ?? ''}`);

    expect(response.status).toBe(HttpStatus.OK);
    const body = response.body as SuccessEnvelope<ProfilePayload>;
    expect(body.payload.user_profile.email).toBe(validRegister.email);
    expect(body.payload.company_profile.primary?.name).toBe(validRegister.company_name);
    expect(body.payload.company_profile.primary?.is_branch).toBe(false);
    expect(body.payload.company_profile.companies.length).toBe(1);
  });

  // ---------- 11) login como employee feliz ----------
  //
  // Para este test creamos un employee on-the-fly como owner: necesitamos un
  // token de owner válido (issuedToken del test 4) y un username único.
  const employeeUsername = `emp-${uniqueSuffix()}`;
  const employeePassword = 'EmpPassSegura1!';
  let employeeId: number | undefined;

  it('POST /api/v1/employees + POST /api/v1/auth/user (200) login dual como employee', async () => {
    expect(issuedToken).toBeDefined();

    // Crear employee con credenciales como owner.
    const createResponse = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${issuedToken ?? ''}`)
      .send({
        name: 'E2E Empleado',
        role: 'employee',
        login_enabled: true,
        username: employeeUsername,
        password: employeePassword,
      });

    expect(createResponse.status).toBe(HttpStatus.CREATED);
    const created = createResponse.body as SuccessEnvelope<{
      id: number;
      username: string;
      login_enabled: boolean;
      has_credentials: boolean;
    }>;
    expect(created.payload.username).toBe(employeeUsername);
    expect(created.payload.login_enabled).toBe(true);
    expect(created.payload.has_credentials).toBe(true);
    employeeId = created.payload.id;

    // Login como employee. El service detecta que no luce email y va al
    // fallback de employees.
    const loginResponse = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username: employeeUsername, password: employeePassword });

    expect(loginResponse.status).toBe(HttpStatus.OK);
    const loginBody = loginResponse.body as SuccessEnvelope<AuthPayload>;
    expect(loginBody.success).toBe(true);
    expect(typeof loginBody.payload.access_token).toBe('string');
    // El type del payload.user refleja el rol del employee, NO 'owner'.
    expect(loginBody.payload.user.type).toBe('employee');
    // lastname es '' (string vacío) por contrato — ver toAuthUserDtoFromEmployee.
    expect(loginBody.payload.user.lastname).toBe('');
    // email SIEMPRE string (mapper proyecta null a '' para alinear con
    // `LoginResponse.user.email: string` del cliente PlacePos).
    expect(typeof loginBody.payload.user.email).toBe('string');
  });

  // ---------- 12) login employee con password mal — mismo mensaje genérico ----------
  it('POST /api/v1/auth/user (401) employee password mal — "Credenciales inválidas"', async () => {
    expect(employeeId).toBeDefined();
    const response = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username: employeeUsername, password: 'wrong-password-zzz' });

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    const body = response.body as ErrorEnvelope;
    expect(body.success).toBe(false);
    // Mismo mensaje exacto que el path de User — anti-enumeración cross-tenant.
    expect(body.error).toBe('Credenciales inválidas');
  });

  // ---------- 13) login como manager — paridad PlacePos: type='employee' literal ----------
  //
  // Blindaje contra regresión del CRIT-1: el JWT y `payload.user.type` SIEMPRE
  // emiten `'employee'` literal para entidades de la tabla `employees`,
  // incluso cuando `role: 'manager'`. El rol granular vive en DB; el contrato
  // HTTP de PlacePos no lo distingue en el token.
  const managerUsername = `mgr-${uniqueSuffix()}`;
  const managerPassword = 'MgrPassSegura1!';

  it('POST /api/v1/employees + login manager (200) → user.type === "employee" literal', async () => {
    expect(issuedToken).toBeDefined();

    // Owner crea manager con login habilitado.
    const createResponse = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${issuedToken ?? ''}`)
      .send({
        name: 'E2E Manager',
        role: 'manager',
        login_enabled: true,
        username: managerUsername,
        password: managerPassword,
      });

    expect(createResponse.status).toBe(HttpStatus.CREATED);
    const created = createResponse.body as SuccessEnvelope<{
      id: number;
      username: string;
      role: string;
      login_enabled: boolean;
    }>;
    expect(created.payload.username).toBe(managerUsername);
    expect(created.payload.role).toBe('manager');
    expect(created.payload.login_enabled).toBe(true);

    // Manager hace login.
    const loginResponse = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username: managerUsername, password: managerPassword });

    expect(loginResponse.status).toBe(HttpStatus.OK);
    const loginBody = loginResponse.body as SuccessEnvelope<AuthPayload>;
    expect(loginBody.success).toBe(true);
    // CRÍTICO: type === 'employee' LITERAL, NO 'manager'. Paridad PlacePos.
    expect(loginBody.payload.user.type).toBe('employee');
  });

  // ---------- 10) logout ----------
  it('POST /api/v1/auth/logout (200) → payload: null', async () => {
    const response = await request(httpServer).post('/api/v1/auth/logout');
    expect(response.status).toBe(HttpStatus.OK);
    const body = response.body as SuccessEnvelope<null>;
    expect(body.success).toBe(true);
    expect(body.payload).toBeNull();
  });
});

// Indicador visible al correr `pnpm test:e2e` cuando los tests están skipped.
if (!SHOULD_RUN) {
  // eslint-disable-next-line no-console
  console.info(
    '[auth.e2e-spec] Tests omitidos. Para correrlos: docker compose up -d postgres && pnpm migration:run && RUN_AUTH_E2E=1 pnpm test:e2e',
  );
}
