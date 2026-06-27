import { HttpStatus, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import type { DataSource } from 'typeorm';

import { tryInitDataSource } from './helpers/e2e-db';

// IMPORTANTE: NO importamos `AppModule` a nivel de módulo (ConfigModule valida
// env al cargar). Lo resolvemos dinámicamente en `beforeAll` SOLO cuando
// RUN_ROLES_E2E=1, igual que `auth.e2e-spec.ts`.

/**
 * E2E de FASE 2 (ROLES Y PERMISOS) contra pos_db.
 *
 * REQUISITOS:
 *   1. Postgres con migraciones aplicadas (`pnpm migration:run`).
 *   2. `JWT_SECRET` en el entorno.
 *   3. Opt-in: `RUN_ROLES_E2E=1 pnpm test:e2e`.
 *
 * Cobertura:
 *   - GET /roles (3 de sistema, employee_count, orden).
 *   - POST /roles (201; 400 permission inválida; 409 nombre duplicado).
 *   - PUT /roles (editar custom y de sistema; is_system inmutable).
 *   - DELETE /roles (422 sistema; ok no-sistema → empleado queda sin rol).
 *   - 403 para no-owner (empleado).
 *   - Asignar role_id a empleado (create/update); role_id de otra company → 400.
 *   - GET /auth/profile incluye `permissions` (owner=18; empleado=rol; legacy).
 *   - Crear sucursal → nace con 3 roles de sistema.
 *
 * Sigue el patrón de `auth.e2e-spec.ts`: registra owners con emails únicos y NO
 * limpia (Postgres de dev tolera filas residuales).
 */

const SHOULD_RUN = process.env.RUN_ROLES_E2E === '1';
const describeIf = SHOULD_RUN ? describe : describe.skip;

interface SuccessEnvelope<T> {
  success: true;
  payload: T;
}

interface ErrorEnvelope {
  success: false;
  error: string;
  payload?: { code?: string };
}

interface RolePayload {
  id: number;
  name: string;
  color: string | null;
  icon: string | null;
  permissions: string[];
  is_system: boolean;
  employee_count: number;
}

const uniqueSuffix = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describeIf('Roles (e2e)', () => {
  let app: INestApplication;
  let httpServer: Server;
  let ds: DataSource | null = null;

  // Owner A — tenant principal de la mayoría de los casos.
  const ownerA = {
    name: 'Owner',
    lastname: 'A',
    email: `roles-a-${uniqueSuffix()}@pos.test`,
    password: 'PasswordSeguro123!',
    company_name: `Roles Co A ${uniqueSuffix()}`,
  };
  let tokenA = '';
  let companyAId = '';
  let ownerAUserId = '';

  // Owner B — para el caso cross-company.
  const ownerB = {
    name: 'Owner',
    lastname: 'B',
    email: `roles-b-${uniqueSuffix()}@pos.test`,
    password: 'PasswordSeguro123!',
    company_name: `Roles Co B ${uniqueSuffix()}`,
  };
  let tokenB = '';
  let roleBId = 0;

  // IDs compartidos entre casos.
  let customRoleId = 0;
  let deletableRoleId = 0;

  const register = async (dto: typeof ownerA): Promise<string> => {
    const res = await request(httpServer).post('/api/v1/auth/register').send(dto);
    expect(res.status).toBe(HttpStatus.CREATED);
    return (res.body as SuccessEnvelope<{ access_token: string }>).payload.access_token;
  };

  beforeAll(async () => {
    const { AppModule } = (await import('@/app.module')) as {
      AppModule: new (...args: unknown[]) => unknown;
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.setGlobalPrefix('api/v1');
    await app.init();
    httpServer = app.getHttpServer() as Server;
    ds = await tryInitDataSource();

    tokenA = await register(ownerA);
    tokenB = await register(ownerB);

    if (ds) {
      const rows: Array<{ id: string; company_id: string }> = await ds.query(
        `SELECT id, company_id FROM users WHERE email = $1`,
        [ownerA.email],
      );
      ownerAUserId = rows[0].id;
      companyAId = rows[0].company_id;
    }
  });

  afterAll(async () => {
    if (ds) {
      await ds.destroy();
    }
    if (app) {
      await app.close();
    }
  });

  // ---------- GET /roles: 3 de sistema, employee_count, orden ----------
  it('GET /roles (200) lista los 3 roles de sistema, is_system primero', async () => {
    const res = await request(httpServer)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(HttpStatus.OK);
    const roles = (res.body as SuccessEnvelope<RolePayload[]>).payload;
    expect(roles).toHaveLength(3);
    expect(roles.map((r) => r.name)).toEqual(['Administrador', 'Cajero', 'Inventarista']);
    expect(roles.every((r) => r.is_system === true)).toBe(true);
    expect(roles.every((r) => r.employee_count === 0)).toBe(true);
    const admin = roles.find((r) => r.name === 'Administrador');
    expect(admin?.permissions).toHaveLength(18);
  });

  // ---------- POST /roles: 400 permission inválida ----------
  it('POST /roles (400) con una permission fuera del catálogo', async () => {
    const res = await request(httpServer)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Inválido ${uniqueSuffix()}`, permissions: ['canAccessPOS', 'canAccessNope'] });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect((res.body as ErrorEnvelope).success).toBe(false);
  });

  // ---------- POST /roles: 201 feliz, dedupe ----------
  const customRoleName = `Supervisor ${uniqueSuffix()}`;
  it('POST /roles (201) crea rol no-sistema, deduplica permisos', async () => {
    const res = await request(httpServer)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: customRoleName,
        color: '#abcdef',
        icon: 'UserCog',
        // duplicado intencional para verificar dedupe.
        permissions: ['canAccessPOS', 'canAccessPOS', 'canAccessExpenses'],
      });

    expect(res.status).toBe(HttpStatus.CREATED);
    const role = (res.body as SuccessEnvelope<RolePayload>).payload;
    expect(role.is_system).toBe(false);
    expect(role.employee_count).toBe(0);
    expect(role.permissions).toEqual(['canAccessPOS', 'canAccessExpenses']);
    expect(role.color).toBe('#abcdef');
    customRoleId = role.id;
  });

  // ---------- POST /roles: 409 nombre duplicado (case-insensitive) ----------
  it('POST /roles (409) nombre duplicado case-insensitive → ROLE_NAME_TAKEN', async () => {
    const res = await request(httpServer)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `  ${customRoleName.toUpperCase()}  `, permissions: ['canAccessPOS'] });

    expect(res.status).toBe(HttpStatus.CONFLICT);
    expect((res.body as ErrorEnvelope).payload?.code).toBe('ROLE_NAME_TAKEN');
  });

  // ---------- PUT /roles/:id: editar custom ----------
  it('PUT /roles/:id (200) edita name y permissions del rol custom', async () => {
    const res = await request(httpServer)
      .put(`/api/v1/roles/${customRoleId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `${customRoleName} v2`, permissions: ['canAccessDashboard'] });

    expect(res.status).toBe(HttpStatus.OK);
    const role = (res.body as SuccessEnvelope<RolePayload>).payload;
    expect(role.name).toBe(`${customRoleName} v2`);
    expect(role.permissions).toEqual(['canAccessDashboard']);
    expect(role.is_system).toBe(false);
  });

  // ---------- PUT /roles/:id: editar rol de SISTEMA (permitido, is_system inmutable) ----------
  it('PUT /roles/:id (200) permite editar un rol de sistema sin cambiar is_system', async () => {
    const list = await request(httpServer)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`);
    const cajero = (list.body as SuccessEnvelope<RolePayload[]>).payload.find(
      (r) => r.name === 'Cajero',
    );
    expect(cajero).toBeDefined();

    // `is_system` no es campo del DTO: el action nunca lo toca, así que el rol
    // de sistema sigue siendo de sistema tras editar sus permisos.
    const res = await request(httpServer)
      .put(`/api/v1/roles/${cajero!.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ permissions: ['canAccessPOS'] });

    expect(res.status).toBe(HttpStatus.OK);
    const role = (res.body as SuccessEnvelope<RolePayload>).payload;
    expect(role.is_system).toBe(true);
    expect(role.permissions).toEqual(['canAccessPOS']);
  });

  // ---------- DELETE /roles/:id: 422 sobre rol de sistema ----------
  it('DELETE /roles/:id (422) no permite borrar un rol de sistema', async () => {
    const list = await request(httpServer)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`);
    const admin = (list.body as SuccessEnvelope<RolePayload[]>).payload.find(
      (r) => r.name === 'Administrador',
    );

    const res = await request(httpServer)
      .delete(`/api/v1/roles/${admin!.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  // ---------- Asignar role_id a un empleado + employee_count + SET NULL al borrar ----------
  let employeeId = 0;
  const employeeUsername = `roles-emp-${uniqueSuffix()}`;
  const employeePassword = 'EmpPassSegura1!';

  it('POST /employees con role_id válido → persiste y employee_count sube a 1', async () => {
    // Rol dedicado que luego borraremos para verificar el SET NULL.
    const created = await request(httpServer)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Borrable ${uniqueSuffix()}`, permissions: ['canAccessPOS'] });
    deletableRoleId = (created.body as SuccessEnvelope<RolePayload>).payload.id;

    const emp = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: 'E2E Empleado Rol',
        login_enabled: true,
        username: employeeUsername,
        password: employeePassword,
        role_id: deletableRoleId,
      });

    expect(emp.status).toBe(HttpStatus.CREATED);
    const empBody = emp.body as SuccessEnvelope<{ id: number; role_id: number | null }>;
    expect(empBody.payload.role_id).toBe(deletableRoleId);
    employeeId = empBody.payload.id;

    const list = await request(httpServer)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`);
    const role = (list.body as SuccessEnvelope<RolePayload[]>).payload.find(
      (r) => r.id === deletableRoleId,
    );
    expect(role?.employee_count).toBe(1);
  });

  it('DELETE /roles/:id (200) borra rol no-sistema; el empleado queda sin rol (SET NULL)', async () => {
    const res = await request(httpServer)
      .delete(`/api/v1/roles/${deletableRoleId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(HttpStatus.OK);
    expect((res.body as SuccessEnvelope<null>).payload).toBeNull();

    const detail = await request(httpServer)
      .get(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect((detail.body as SuccessEnvelope<{ role_id: number | null }>).payload.role_id).toBeNull();
  });

  // ---------- role_id de OTRA company → 400 ----------
  it('POST /employees con role_id de otra company → 400', async () => {
    // Owner B crea un rol en SU company.
    const roleBRes = await request(httpServer)
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: `Rol B ${uniqueSuffix()}`, permissions: ['canAccessPOS'] });
    roleBId = (roleBRes.body as SuccessEnvelope<RolePayload>).payload.id;

    // Owner A intenta asignar ese rol ajeno a un empleado suyo.
    const res = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Empleado Rol Ajeno', login_enabled: false, role_id: roleBId });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('PUT /employees/:id con role_id de otra company → 400', async () => {
    const res = await request(httpServer)
      .put(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ role_id: roleBId });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  // ---------- 403 para no-owner (empleado) ----------
  it('GET /roles (403) para un empleado (no owner)', async () => {
    const login = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username: employeeUsername, password: employeePassword });
    const empToken = (login.body as SuccessEnvelope<{ access_token: string }>).payload.access_token;

    const res = await request(httpServer)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${empToken}`);

    expect(res.status).toBe(HttpStatus.FORBIDDEN);
  });

  // ---------- profile: permissions ----------
  it('GET /auth/profile (owner) incluye permissions con las 18 keys', async () => {
    const res = await request(httpServer)
      .get('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(HttpStatus.OK);
    const perms = (res.body as SuccessEnvelope<{ user_profile: { permissions: string[] } }>).payload
      .user_profile.permissions;
    expect(perms).toHaveLength(18);
    expect(perms).toContain('canAccessSettings');
  });

  it('GET /auth/profile (empleado sin rol) incluye permissions LEGACY', async () => {
    const login = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username: employeeUsername, password: employeePassword });
    const empToken = (login.body as SuccessEnvelope<{ access_token: string }>).payload.access_token;

    const res = await request(httpServer)
      .get('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${empToken}`);

    expect(res.status).toBe(HttpStatus.OK);
    const perms = (res.body as SuccessEnvelope<{ user_profile: { permissions: string[] } }>).payload
      .user_profile.permissions;
    // El empleado quedó sin rol tras el DELETE → permisos legacy (9 keys).
    expect(perms).toEqual([
      'canAccessPOS',
      'canAccessInventory',
      'canAccessPackaging',
      'canAccessCategories',
      'canAccessCustomers',
      'canAccessCarriers',
      'canAccessSalesReport',
      'canAccessClientsReport',
      'canAccessExpenses',
    ]);
  });

  it('GET /auth/profile (empleado con rol) refleja los permisos del rol', async () => {
    // Asignar un rol concreto al empleado y verificar que el perfil lo refleja.
    const updated = await request(httpServer)
      .put(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ role_id: customRoleId });
    expect(updated.status).toBe(HttpStatus.OK);

    const login = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username: employeeUsername, password: employeePassword });
    const empToken = (login.body as SuccessEnvelope<{ access_token: string }>).payload.access_token;

    const res = await request(httpServer)
      .get('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${empToken}`);
    const perms = (res.body as SuccessEnvelope<{ user_profile: { permissions: string[] } }>).payload
      .user_profile.permissions;
    // customRoleId quedó con ['canAccessDashboard'] tras el PUT previo.
    expect(perms).toEqual(['canAccessDashboard']);
  });

  // ---------- Seed de roles en una sucursal nueva ----------
  it('POST /branches → la sucursal nace con los 3 roles de sistema', async () => {
    if (!ds) {
      console.warn('pos_db no disponible — verificación de seed en sucursal omitida');
      return;
    }
    // Habilitar sucursales para el owner A (gating del backend).
    await ds.query(
      `UPDATE users SET branches_enabled = true, branches_allowed = 10 WHERE id = $1`,
      [ownerAUserId],
    );

    const res = await request(httpServer)
      .post('/api/v1/branches')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ company_name: `Sucursal ${uniqueSuffix()}` });

    expect(res.status).toBe(HttpStatus.CREATED);
    const branch = (res.body as SuccessEnvelope<{ id: number }>).payload;

    const roles: Array<{ name: string; is_system: boolean }> = await ds.query(
      `SELECT name, is_system FROM roles WHERE company_id = $1 AND is_system = true ORDER BY name`,
      [String(branch.id)],
    );
    expect(roles.map((r) => r.name)).toEqual(['Administrador', 'Cajero', 'Inventarista']);
  });

  // Sanity: companyAId capturado (depende de pos_db).
  it('captura company_id de owner A si hay BD', () => {
    if (ds) {
      expect(companyAId.length).toBeGreaterThan(0);
    }
  });
});

if (!SHOULD_RUN) {
  // eslint-disable-next-line no-console
  console.info(
    '[roles.e2e-spec] Tests omitidos. Para correrlos: docker compose up -d postgres && pnpm migration:run && RUN_ROLES_E2E=1 pnpm test:e2e',
  );
}
