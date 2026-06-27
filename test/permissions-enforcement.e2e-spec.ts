import { HttpStatus, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import type { DataSource } from 'typeorm';

import { tryInitDataSource } from './helpers/e2e-db';

// IMPORTANTE: NO importamos `AppModule` a nivel de módulo (ConfigModule valida
// env al cargar). Lo resolvemos dinámicamente en `beforeAll` SOLO cuando
// RUN_PERMISSIONS_E2E=1, igual que `roles.e2e-spec.ts`.

/**
 * E2E de FASE 4 (ENFORCEMENT DE PERMISOS) contra pos_db.
 *
 * REQUISITOS:
 *   1. Postgres con migraciones aplicadas.
 *   2. `JWT_SECRET` en el entorno.
 *   3. Opt-in: `RUN_PERMISSIONS_E2E=1 pnpm test:e2e`.
 *
 * Cobertura:
 *   - El `PermissionsGuard` GATEA de verdad a un empleado en los endpoints
 *     donde su `@Roles` ya admite `employee` y añadimos `@RequirePermission`:
 *       · GET /purchases (canAccessPurchase): Inventarista (con la key) pasa;
 *         Cajero (sin la key) → 403.
 *       · GET /pos-reports/sales (canAccessSalesReport): Cajero (con la key)
 *         pasa; Inventarista (sin la key) → 403.
 *   - owner SIEMPRE pasa los endpoints protegidos (mutaciones y reportes).
 *   - Mutación protegida (POST /banks): owner pasa; un empleado sin la key
 *     recibe 403.
 *   - NUEVA REGLA (gate = PERMISO, no rol): un empleado con un rol custom que
 *     concede canAccessBanks/Wallets/Suppliers PUEDE gestionar (POST/PUT) bancos,
 *     wallets y proveedores — aunque su JWT sea type='employee'. La ÚNICA
 *     excepción solo-admin son los AJUSTES MANUALES DE SALDO
 *     (`POST /banks|wallets/:id/adjustments` → 403 para el empleado, 201 owner).
 *   - CRÍTICO (no romper el POS): un empleado con rol Cajero
 *     (canAccessPOS/SalesReport/ClientsReport/Expenses/Customers, SIN
 *     canAccessBanks/Wallets/Inventory) PUEDE: GET /banks, GET /wallets,
 *     GET /inventory (productos), GET /customers y operar /sales.
 *
 * Sigue el patrón de `roles.e2e-spec.ts`: owners con emails únicos, sin
 * cleanup agresivo.
 */

const SHOULD_RUN = process.env.RUN_PERMISSIONS_E2E === '1';
const describeIf = SHOULD_RUN ? describe : describe.skip;

interface SuccessEnvelope<T> {
  success: true;
  payload: T;
}

interface RolePayload {
  id: number;
  name: string;
  permissions: string[];
  is_system: boolean;
}

const uniqueSuffix = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describeIf('Permissions enforcement (e2e)', () => {
  let app: INestApplication;
  let httpServer: Server;
  let ds: DataSource | null = null;

  const owner = {
    name: 'Owner',
    lastname: 'Perms',
    email: `perms-${uniqueSuffix()}@pos.test`,
    password: 'PasswordSeguro123!',
    company_name: `Perms Co ${uniqueSuffix()}`,
  };
  let ownerToken = '';

  // Tokens de empleados con roles de sistema.
  let cajeroToken = '';
  let inventaristaToken = '';

  const register = async (): Promise<string> => {
    const res = await request(httpServer).post('/api/v1/auth/register').send(owner);
    expect(res.status).toBe(HttpStatus.CREATED);
    return (res.body as SuccessEnvelope<{ access_token: string }>).payload.access_token;
  };

  const createEmployeeWithRole = async (
    username: string,
    password: string,
    roleId: number,
  ): Promise<string> => {
    const emp = await request(httpServer)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: username, login_enabled: true, username, password, role_id: roleId });
    expect(emp.status).toBe(HttpStatus.CREATED);

    const login = await request(httpServer)
      .post('/api/v1/auth/user')
      .send({ username, password });
    expect(login.status).toBeLessThan(HttpStatus.BAD_REQUEST);
    const token = (login.body as SuccessEnvelope<{ access_token: string }>).payload.access_token;
    expect(typeof token).toBe('string');
    return token;
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

    ownerToken = await register();

    // Roles de sistema sembrados al registrar la company.
    const rolesRes = await request(httpServer)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${ownerToken}`);
    const roles = (rolesRes.body as SuccessEnvelope<RolePayload[]>).payload;
    const cajero = roles.find((r) => r.name === 'Cajero');
    const inventarista = roles.find((r) => r.name === 'Inventarista');
    expect(cajero).toBeDefined();
    expect(inventarista).toBeDefined();

    // Sanity de los seeds: las keys que sustentan el cruce de tests.
    expect(cajero!.permissions).toContain('canAccessSalesReport');
    expect(cajero!.permissions).not.toContain('canAccessPurchase');
    expect(cajero!.permissions).not.toContain('canAccessBanks');
    expect(inventarista!.permissions).toContain('canAccessPurchase');
    expect(inventarista!.permissions).not.toContain('canAccessSalesReport');

    cajeroToken = await createEmployeeWithRole(
      `cajero-${uniqueSuffix()}`,
      'CajeroPass1!',
      cajero!.id,
    );
    inventaristaToken = await createEmployeeWithRole(
      `invent-${uniqueSuffix()}`,
      'InventPass1!',
      inventarista!.id,
    );
  });

  afterAll(async () => {
    if (ds) {
      await ds.destroy();
    }
    if (app) {
      await app.close();
    }
  });

  const get = (path: string, token: string): request.Test =>
    request(httpServer).get(path).set('Authorization', `Bearer ${token}`);

  // ======================================================================
  // PermissionsGuard gatea de verdad a empleados (su @Roles admite employee)
  // ======================================================================

  describe('GET /purchases (canAccessPurchase)', () => {
    it('Inventarista (CON la key) → 200', async () => {
      const res = await get('/api/v1/purchases', inventaristaToken);
      expect(res.status).toBe(HttpStatus.OK);
    });

    it('Cajero (SIN la key) → 403', async () => {
      const res = await get('/api/v1/purchases', cajeroToken);
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('owner → 200 (bypass de permisos)', async () => {
      const res = await get('/api/v1/purchases', ownerToken);
      expect(res.status).toBe(HttpStatus.OK);
    });
  });

  // El handler exige dateFrom/dateTo (400 si faltan). El gating de permiso
  // (403) corre ANTES del ValidationPipe, así que el caso negativo no los
  // necesita; los positivos sí para llegar al 200.
  const salesReportPath = '/api/v1/pos-reports/sales?dateFrom=2026-01-01&dateTo=2026-12-31';

  describe('GET /pos-reports/sales (canAccessSalesReport)', () => {
    it('Cajero (CON la key) → 200', async () => {
      const res = await get(salesReportPath, cajeroToken);
      expect(res.status).toBe(HttpStatus.OK);
    });

    it('Inventarista (SIN la key) → 403', async () => {
      const res = await get(salesReportPath, inventaristaToken);
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('owner → 200 (bypass de permisos)', async () => {
      const res = await get(salesReportPath, ownerToken);
      expect(res.status).toBe(HttpStatus.OK);
    });
  });

  // ======================================================================
  // Mutación protegida: owner pasa; empleado sin la key → 403
  // ======================================================================

  describe('POST /banks (canAccessBanks)', () => {
    it('owner → 201', async () => {
      const res = await request(httpServer)
        .post('/api/v1/banks')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: `Banco E2E ${uniqueSuffix()}`,
          account_number: `0001-${uniqueSuffix()}`,
          account_type: 'savings',
        });
      expect(res.status).toBe(HttpStatus.CREATED);
    });

    it('Cajero (sin canAccessBanks) → 403', async () => {
      const res = await request(httpServer)
        .post('/api/v1/banks')
        .set('Authorization', `Bearer ${cajeroToken}`)
        .send({
          name: `Banco Cajero ${uniqueSuffix()}`,
          account_number: `0002-${uniqueSuffix()}`,
          account_type: 'savings',
        });
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });
  });

  // ======================================================================
  // Reportes standalone: owner pasa (bypass)
  // ======================================================================

  describe('Reportes standalone (owner pasa)', () => {
    it('GET /reports/daily-closure (canAccessDailyClosureReport) → 200', async () => {
      const res = await get('/api/v1/reports/daily-closure', ownerToken);
      expect(res.status).toBe(HttpStatus.OK);
    });

    it('GET /dashboard/today-by-cashier (canAccessCashierReport) → 200', async () => {
      const res = await get('/api/v1/dashboard/today-by-cashier', ownerToken);
      expect(res.status).toBe(HttpStatus.OK);
    });

    it('GET /reports/customers-rfm (canAccessClientsReport) → 200', async () => {
      const res = await get('/api/v1/reports/customers-rfm', ownerToken);
      expect(res.status).toBe(HttpStatus.OK);
    });
  });

  // ======================================================================
  // NUEVA REGLA: la GESTIÓN la habilita el PERMISO del módulo, no el rol.
  // En cloud TODO empleado (incluidos managers) tiene JWT type='employee';
  // un rol custom con la key del módulo debe poder crear/editar. La ÚNICA
  // excepción solo-admin son los AJUSTES MANUALES DE SALDO.
  // ======================================================================

  describe('Gestión habilitada por PERMISO (no por rol)', () => {
    let tesoreroToken = '';
    let bankId = 0;
    let walletId = 0;
    let supplierId = 0;

    beforeAll(async () => {
      const roleRes = await request(httpServer)
        .post('/api/v1/roles')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: `Tesorero ${uniqueSuffix()}`,
          permissions: ['canAccessBanks', 'canAccessWallets', 'canAccessSuppliers'],
        });
      expect(roleRes.status).toBe(HttpStatus.CREATED);
      const roleId = (roleRes.body as SuccessEnvelope<RolePayload>).payload.id;

      tesoreroToken = await createEmployeeWithRole(
        `tesorero-${uniqueSuffix()}`,
        'TesoreroPass1!',
        roleId,
      );
    });

    // ---- BANKS: gestión SÍ, ajuste de saldo NO ----
    it('Tesorero (CON canAccessBanks) PUEDE POST /banks → 201', async () => {
      const res = await request(httpServer)
        .post('/api/v1/banks')
        .set('Authorization', `Bearer ${tesoreroToken}`)
        .send({
          name: `Banco Tesorero ${uniqueSuffix()}`,
          account_number: `T-${uniqueSuffix()}`,
          account_type: 'savings',
        });
      expect(res.status).toBe(HttpStatus.CREATED);
      bankId = (res.body as SuccessEnvelope<{ id: number }>).payload.id;
      expect(bankId).toBeGreaterThan(0);
    });

    it('Tesorero PUEDE PUT /banks/:id → 200', async () => {
      const res = await request(httpServer)
        .put(`/api/v1/banks/${bankId}`)
        .set('Authorization', `Bearer ${tesoreroToken}`)
        .send({
          name: `Banco Tesorero Editado ${uniqueSuffix()}`,
          account_number: `T-${uniqueSuffix()}`,
          account_type: 'checking',
        });
      expect(res.status).toBe(HttpStatus.OK);
    });

    it('Tesorero NO PUEDE POST /banks/:id/adjustments → 403 (solo-admin)', async () => {
      const res = await request(httpServer)
        .post(`/api/v1/banks/${bankId}/adjustments`)
        .set('Authorization', `Bearer ${tesoreroToken}`)
        .send({ movement_type: 'INCOME', amount: 10, description: 'no permitido' });
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('owner SÍ PUEDE POST /banks/:id/adjustments → 201', async () => {
      const res = await request(httpServer)
        .post(`/api/v1/banks/${bankId}/adjustments`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ movement_type: 'INCOME', amount: 10, description: 'cuadre owner' });
      expect(res.status).toBe(HttpStatus.CREATED);
    });

    // ---- WALLETS: gestión SÍ, ajuste de saldo NO ----
    it('Tesorero (CON canAccessWallets) PUEDE POST /wallets → 201', async () => {
      const res = await request(httpServer)
        .post('/api/v1/wallets')
        .set('Authorization', `Bearer ${tesoreroToken}`)
        .send({ name: `Wallet Tesorero ${uniqueSuffix()}` });
      expect(res.status).toBe(HttpStatus.CREATED);
      walletId = (res.body as SuccessEnvelope<{ id: number }>).payload.id;
      expect(walletId).toBeGreaterThan(0);
    });

    it('Tesorero NO PUEDE POST /wallets/:id/adjustments → 403 (solo-admin)', async () => {
      const res = await request(httpServer)
        .post(`/api/v1/wallets/${walletId}/adjustments`)
        .set('Authorization', `Bearer ${tesoreroToken}`)
        .send({ movement_type: 'INCOME', amount: 10, description: 'no permitido' });
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    // ---- SUPPLIERS: gestión SÍ ----
    it('Tesorero (CON canAccessSuppliers) PUEDE POST /suppliers → 201', async () => {
      const res = await request(httpServer)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${tesoreroToken}`)
        .send({ legal_name: `Proveedor Tesorero ${uniqueSuffix()}` });
      expect(res.status).toBe(HttpStatus.CREATED);
      supplierId = (res.body as SuccessEnvelope<{ id: number }>).payload.id;
      expect(supplierId).toBeGreaterThan(0);
    });

    it('Tesorero PUEDE PUT /suppliers/:id → 200', async () => {
      const res = await request(httpServer)
        .put(`/api/v1/suppliers/${supplierId}`)
        .set('Authorization', `Bearer ${tesoreroToken}`)
        .send({ legal_name: `Proveedor Editado ${uniqueSuffix()}` });
      expect(res.status).toBe(HttpStatus.OK);
    });

    // ---- Empleado SIN la key sigue 403 en la gestión ----
    it('Cajero (SIN canAccessWallets) NO PUEDE POST /wallets → 403', async () => {
      const res = await request(httpServer)
        .post('/api/v1/wallets')
        .set('Authorization', `Bearer ${cajeroToken}`)
        .send({ name: `Wallet Cajero ${uniqueSuffix()}` });
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('Cajero (SIN canAccessSuppliers) NO PUEDE POST /suppliers → 403', async () => {
      const res = await request(httpServer)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${cajeroToken}`)
        .send({ legal_name: `Proveedor Cajero ${uniqueSuffix()}` });
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });
  });

  // ======================================================================
  // CRÍTICO: el Cajero NO se rompe — lecturas compartidas + /sales
  // ======================================================================

  describe('CRÍTICO — el Cajero opera el POS sin fricción', () => {
    it('GET /banks → 200 (cobrar transferencia)', async () => {
      const res = await get('/api/v1/banks', cajeroToken);
      expect(res.status).toBe(HttpStatus.OK);
    });

    it('GET /wallets → 200 (cobrar billetera)', async () => {
      const res = await get('/api/v1/wallets', cajeroToken);
      expect(res.status).toBe(HttpStatus.OK);
    });

    it('GET /inventory (productos) → 200', async () => {
      const res = await get('/api/v1/inventory', cajeroToken);
      expect(res.status).toBe(HttpStatus.OK);
    });

    it('GET /customers → 200', async () => {
      const res = await get('/api/v1/customers', cajeroToken);
      expect(res.status).toBe(HttpStatus.OK);
    });

    it('GET /sales → 200 (operar el POS)', async () => {
      const res = await get('/api/v1/sales', cajeroToken);
      expect(res.status).toBe(HttpStatus.OK);
    });
  });
});

if (!SHOULD_RUN) {
  // eslint-disable-next-line no-console
  console.info(
    '[permissions-enforcement.e2e-spec] Tests omitidos. Para correrlos: docker compose up -d postgres && pnpm migration:run && RUN_PERMISSIONS_E2E=1 pnpm test:e2e',
  );
}
