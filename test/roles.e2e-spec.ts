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
 *   - GET /roles (2 de sistema, employee_count, orden, is_editable).
 *   - POST /roles (201 is_editable=true; 400 permission inválida; 409 nombre duplicado).
 *   - PUT /roles (editar custom y Cajero; Administrador inmutable → 422).
 *   - DELETE /roles (422 inmutable; 422 sistema; ok no-sistema → empleado queda sin rol).
 *   - 403 para no-owner (empleado).
 *   - Asignar role_id a empleado (create/update); role_id de otra company → 400.
 *   - GET /auth/profile incluye `permissions` (owner=18; empleado=rol; legacy).
 *   - Crear sucursal → nace con 2 roles de sistema.
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
  is_editable: boolean;
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

  // ---------- GET /roles: 2 de sistema, employee_count, orden, editabilidad ----------
  it('GET /roles (200) lista los 2 roles de sistema, is_system primero', async () => {
    const res = await request(httpServer)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(HttpStatus.OK);
    const roles = (res.body as SuccessEnvelope<RolePayload[]>).payload;
    // 3 roles de fábrica (Administrador, Cajero, Vendedor); 'Inventarista' eliminado.
    expect(roles).toHaveLength(3);
    expect(roles.map((r) => r.name)).toEqual(['Administrador', 'Cajero', 'Vendedor']);
    expect(roles.find((r) => r.name === 'Inventarista')).toBeUndefined();
    expect(roles.every((r) => r.is_system === true)).toBe(true);
    expect(roles.every((r) => r.employee_count === 0)).toBe(true);
    const admin = roles.find((r) => r.name === 'Administrador');
    expect(admin?.permissions).toHaveLength(22);
    // Administrador INMUTABLE; Cajero EDITABLE.
    expect(admin?.is_editable).toBe(false);
    expect(roles.find((r) => r.name === 'Cajero')?.is_editable).toBe(true);
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
    // Todo rol creado vía API es editable (nunca inmutable).
    expect(role.is_editable).toBe(true);
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

  // ---------- PUT /roles/:id: 422 sobre el rol INMUTABLE 'Administrador' ----------
  it('PUT /roles/:id (422) no permite editar el Administrador → ROLE_NOT_EDITABLE', async () => {
    const list = await request(httpServer)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`);
    const admin = (list.body as SuccessEnvelope<RolePayload[]>).payload.find(
      (r) => r.name === 'Administrador',
    );
    expect(admin).toBeDefined();

    const res = await request(httpServer)
      .put(`/api/v1/roles/${admin!.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ permissions: ['canAccessPOS'] });

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((res.body as ErrorEnvelope).payload?.code).toBe('ROLE_NOT_EDITABLE');

    // El Administrador conserva sus 22 permisos (no se degradó).
    const after = await request(httpServer)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`);
    const adminAfter = (after.body as SuccessEnvelope<RolePayload[]>).payload.find(
      (r) => r.name === 'Administrador',
    );
    expect(adminAfter?.permissions).toHaveLength(22);
  });

  // ---------- DELETE /roles/:id: 422 sobre el rol INMUTABLE 'Administrador' ----------
  it('DELETE /roles/:id (422) no permite borrar el Administrador → ROLE_NOT_EDITABLE', async () => {
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
    expect((res.body as ErrorEnvelope).payload?.code).toBe('ROLE_NOT_EDITABLE');
  });

  // ---------- DELETE /roles/:id: 422 sobre rol de sistema EDITABLE (Cajero) ----------
  it('DELETE /roles/:id (422) no permite borrar el Cajero (rol de sistema)', async () => {
    const list = await request(httpServer)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`);
    const cajero = (list.body as SuccessEnvelope<RolePayload[]>).payload.find(
      (r) => r.name === 'Cajero',
    );

    const res = await request(httpServer)
      .delete(`/api/v1/roles/${cajero!.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    // Cajero es editable pero de sistema → 422 por is_system.
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
  it('GET /auth/profile (owner) incluye permissions con las 22 keys', async () => {
    const res = await request(httpServer)
      .get('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(HttpStatus.OK);
    const perms = (res.body as SuccessEnvelope<{ user_profile: { permissions: string[] } }>).payload
      .user_profile.permissions;
    expect(perms).toHaveLength(22);
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
    // El empleado quedó sin rol tras el DELETE → permisos legacy (12 keys,
    // debe coincidir con LEGACY_EMPLOYEE_PERMISSIONS del catálogo).
    expect(perms).toEqual([
      'canAccessPOS',
      'canAccessInventory',
      'canAccessPackaging',
      'canAccessCategories',
      'canAccessCustomers',
      'canAccessCarriers',
      'canAccessSalesReport',
      'canAccessCreditsReport',
      'canAccessComparativeReport',
      'canAccessClientsReport',
      'canAccessExpenses',
      'canAccessFixedExpenses',
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

  // ---------- Default 'Vendedor' al conceder acceso al sistema ----------
  //
  // Regla de negocio: un rol SOLO tiene sentido con acceso al sistema. Al crear
  // un empleado CON login y SIN rol explícito, se le asigna 'Vendedor' (el más
  // restringido). Sin acceso, role_id queda null aunque venga un rol. Habilitar
  // el login después (toggle-login OFF→ON) también asigna 'Vendedor' si no tenía
  // rol, pero NUNCA pisa uno ya asignado.
  const findVendedorRoleId = async (): Promise<number> => {
    const list = await request(httpServer)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${tokenA}`);
    const vendedor = (list.body as SuccessEnvelope<RolePayload[]>).payload.find(
      (r) => r.name === 'Vendedor',
    );
    expect(vendedor).toBeDefined();
    return vendedor!.id;
  };

  it('POST /employees con login_enabled=true SIN role_id → asigna "Vendedor" por defecto', async () => {
    const vendedorId = await findVendedorRoleId();
    const res = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: 'Empleado Default Vendedor',
        login_enabled: true,
        username: `def-vend-${uniqueSuffix()}`,
        password: 'EmpPassSegura1!',
      });
    expect(res.status).toBe(HttpStatus.CREATED);
    expect((res.body as SuccessEnvelope<{ role_id: number | null }>).payload.role_id).toBe(
      vendedorId,
    );
  });

  it('POST /employees con login_enabled=false SIN role_id → role_id null (sin acceso, sin rol)', async () => {
    const res = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Empleado Sin Acceso', login_enabled: false });
    expect(res.status).toBe(HttpStatus.CREATED);
    expect((res.body as SuccessEnvelope<{ role_id: number | null }>).payload.role_id).toBeNull();
  });

  it('POST /employees con login_enabled=false y role_id válido → role_id null (rol ignorado sin acceso)', async () => {
    const vendedorId = await findVendedorRoleId();
    const res = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Empleado Rol Ignorado', login_enabled: false, role_id: vendedorId });
    expect(res.status).toBe(HttpStatus.CREATED);
    expect((res.body as SuccessEnvelope<{ role_id: number | null }>).payload.role_id).toBeNull();
  });

  it('POST /employees con login_enabled=true y role_id explícito → respeta ese rol (no default)', async () => {
    // customRoleId existe (['canAccessDashboard']). Debe respetarse tal cual, sin
    // caer al default 'Vendedor'.
    const res = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: 'Empleado Rol Explícito',
        login_enabled: true,
        username: `expl-role-${uniqueSuffix()}`,
        password: 'EmpPassSegura1!',
        role_id: customRoleId,
      });
    expect(res.status).toBe(HttpStatus.CREATED);
    expect((res.body as SuccessEnvelope<{ role_id: number | null }>).payload.role_id).toBe(
      customRoleId,
    );
  });

  it('PUT /employees/:id/toggle-login OFF→ON en empleado sin rol → asigna "Vendedor"', async () => {
    const vendedorId = await findVendedorRoleId();
    // 1) Crear sin acceso (sin rol).
    const username = `toggle-vend-${uniqueSuffix()}`;
    const created = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Empleado Toggle', login_enabled: false });
    const createdBody = created.body as SuccessEnvelope<{ id: number; role_id: number | null }>;
    const id = createdBody.payload.id;
    expect(createdBody.payload.role_id).toBeNull();

    // 2) Asignar credenciales (requisito para habilitar login).
    const creds = await request(httpServer)
      .put(`/api/v1/employees/${id}/credentials`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ username, password: 'EmpPassSegura1!' });
    expect(creds.status).toBe(HttpStatus.OK);

    // 3) Conceder acceso → debe recibir 'Vendedor' por defecto.
    const toggled = await request(httpServer)
      .put(`/api/v1/employees/${id}/toggle-login`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ enabled: true });
    expect(toggled.status).toBe(HttpStatus.OK);

    const detail = await request(httpServer)
      .get(`/api/v1/employees/${id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect((detail.body as SuccessEnvelope<{ role_id: number | null }>).payload.role_id).toBe(
      vendedorId,
    );
  });

  it('PUT /employees/:id/toggle-login NO pisa un rol ya asignado', async () => {
    // Empleado con login + rol explícito (customRoleId).
    const username = `toggle-keep-${uniqueSuffix()}`;
    const created = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: 'Empleado Conserva Rol',
        login_enabled: true,
        username,
        password: 'EmpPassSegura1!',
        role_id: customRoleId,
      });
    const id = (created.body as SuccessEnvelope<{ id: number }>).payload.id;

    // OFF y luego ON: el rol debe permanecer intacto (no se re-defaultea).
    await request(httpServer)
      .put(`/api/v1/employees/${id}/toggle-login`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ enabled: false });
    await request(httpServer)
      .put(`/api/v1/employees/${id}/toggle-login`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ enabled: true });

    const detail = await request(httpServer)
      .get(`/api/v1/employees/${id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect((detail.body as SuccessEnvelope<{ role_id: number | null }>).payload.role_id).toBe(
      customRoleId,
    );
  });

  // ---------- ARCHIVAR / RESTAURAR empleado ----------
  //
  // Reglas de negocio:
  //   - Archivar setea is_archived=true Y login_enabled=false (revoca acceso).
  //   - El empleado archivado desaparece del listado por defecto pero SÍ
  //     aparece con ?includeArchived=true, y GET /:id sigue devolviéndolo.
  //   - Restaurar setea is_archived=false (NO re-habilita login).
  //   - Idempotencia: doble archive → 200.
  //   - Owner-only: un empleado (no-owner) recibe 403 en archive/restore.
  interface ArchivablePayload {
    id: number;
    is_archived: boolean;
    login_enabled: boolean;
  }

  let archivableId = 0;
  const archivableUsername = `archivable-${uniqueSuffix()}`;

  it('setup: crea un empleado con login para las pruebas de archivado', async () => {
    const res = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: 'Empleado Archivable',
        login_enabled: true,
        username: archivableUsername,
        password: 'EmpPassSegura1!',
      });
    expect(res.status).toBe(HttpStatus.CREATED);
    const body = res.body as SuccessEnvelope<ArchivablePayload>;
    expect(body.payload.is_archived).toBe(false);
    expect(body.payload.login_enabled).toBe(true);
    archivableId = body.payload.id;
  });

  it('PUT /employees/:id/archive (200) → is_archived=true y login_enabled=false', async () => {
    const res = await request(httpServer)
      .put(`/api/v1/employees/${archivableId}/archive`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(HttpStatus.OK);
    const body = res.body as SuccessEnvelope<ArchivablePayload>;
    expect(body.payload.is_archived).toBe(true);
    // Archivar REVOCA el acceso: login_enabled debe apagarse.
    expect(body.payload.login_enabled).toBe(false);
  });

  it('GET /employees (default) NO incluye al empleado archivado', async () => {
    const res = await request(httpServer)
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(HttpStatus.OK);
    const list = (res.body as SuccessEnvelope<ArchivablePayload[]>).payload;
    expect(list.find((e) => e.id === archivableId)).toBeUndefined();
  });

  it('SEGURIDAD: un empleado archivado NO puede autenticarse (login → 401)', async () => {
    // Archivar revoca el acceso: aunque conserve username/password, el login por
    // username filtra is_archived + login_enabled → credenciales inválidas.
    const res = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username: archivableUsername, password: 'EmpPassSegura1!' });
    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('GET /employees?includeArchived=true SÍ incluye al empleado archivado', async () => {
    const res = await request(httpServer)
      .get('/api/v1/employees?includeArchived=true')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(HttpStatus.OK);
    const list = (res.body as SuccessEnvelope<ArchivablePayload[]>).payload;
    const found = list.find((e) => e.id === archivableId);
    expect(found).toBeDefined();
    expect(found?.is_archived).toBe(true);
  });

  it('GET /employees/:id devuelve el empleado aunque esté archivado', async () => {
    const res = await request(httpServer)
      .get(`/api/v1/employees/${archivableId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(HttpStatus.OK);
    const body = res.body as SuccessEnvelope<ArchivablePayload>;
    expect(body.payload.id).toBe(archivableId);
    expect(body.payload.is_archived).toBe(true);
  });

  it('PUT /employees/:id/archive es idempotente (doble archive → 200)', async () => {
    const res = await request(httpServer)
      .put(`/api/v1/employees/${archivableId}/archive`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(HttpStatus.OK);
    expect((res.body as SuccessEnvelope<ArchivablePayload>).payload.is_archived).toBe(true);
  });

  it('PUT /employees/:id/restore (200) → is_archived=false; reaparece en la lista default', async () => {
    const res = await request(httpServer)
      .put(`/api/v1/employees/${archivableId}/restore`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(HttpStatus.OK);
    const body = res.body as SuccessEnvelope<ArchivablePayload>;
    expect(body.payload.is_archived).toBe(false);
    // Restaurar NO re-habilita el login (sigue apagado tras el archive).
    expect(body.payload.login_enabled).toBe(false);

    const list = await request(httpServer)
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`);
    const found = (list.body as SuccessEnvelope<ArchivablePayload[]>).payload.find(
      (e) => e.id === archivableId,
    );
    expect(found).toBeDefined();
    expect(found?.is_archived).toBe(false);
  });

  it('PUT /employees/:id/restore es idempotente (doble restore → 200)', async () => {
    const res = await request(httpServer)
      .put(`/api/v1/employees/${archivableId}/restore`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(HttpStatus.OK);
    expect((res.body as SuccessEnvelope<ArchivablePayload>).payload.is_archived).toBe(false);
  });

  it('archive/restore → 403 para un no-owner (empleado)', async () => {
    // El empleado `employeeUsername` puede loguearse (tiene rol customRoleId).
    const login = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username: employeeUsername, password: employeePassword });
    const empToken = (login.body as SuccessEnvelope<{ access_token: string }>).payload.access_token;

    const archiveRes = await request(httpServer)
      .put(`/api/v1/employees/${archivableId}/archive`)
      .set('Authorization', `Bearer ${empToken}`);
    expect(archiveRes.status).toBe(HttpStatus.FORBIDDEN);

    const restoreRes = await request(httpServer)
      .put(`/api/v1/employees/${archivableId}/restore`)
      .set('Authorization', `Bearer ${empToken}`);
    expect(restoreRes.status).toBe(HttpStatus.FORBIDDEN);

    // El estado del empleado no cambió (sigue restaurado).
    const detail = await request(httpServer)
      .get(`/api/v1/employees/${archivableId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect((detail.body as SuccessEnvelope<ArchivablePayload>).payload.is_archived).toBe(false);
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
    expect(roles.map((r) => r.name)).toEqual(['Administrador', 'Cajero', 'Vendedor']);
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
