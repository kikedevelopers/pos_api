import {
  BUSINESS_ID_PARAM,
  buildBusinessesContext,
  hasMultipleBusinesses,
  queryableBusinesses,
  resolveBusinessScope,
  withBusinessIdParam,
  type AiBusiness,
} from '../internal/business-scope';
import {
  acceptsBusinessScope,
  AI_TOOLS,
  declarationsFor,
  findTool,
  isToolAllowed,
  toolSummariesFor,
  type AiToolActor,
  type AiToolDefinition,
} from '../internal/tool-catalog';

const MAIN: AiBusiness = { id: 10, name: 'Surtidor La 21', is_branch: false, is_active: true };
const NORTE: AiBusiness = { id: 11, name: 'Sucursal Norte', is_branch: true, is_active: true };
const BODEGA: AiBusiness = { id: 12, name: 'Bodega Sur', is_branch: true, is_active: false };

const owner = (businesses: AiBusiness[] = [MAIN, NORTE, BODEGA]): AiToolActor => ({
  isAdmin: true,
  permissions: new Set<string>(),
  canViewProfit: true,
  userId: 1,
  is_administrator: true,
  businesses,
});

const tool = (name: string): AiToolDefinition => {
  const found = findTool(name);
  if (!found) {
    throw new Error(`Herramienta inexistente: ${name}`);
  }
  return found;
};

const READ_TOOLS = AI_TOOLS.filter(
  (tool) => tool.requires_administrator !== true && tool.requires_branches !== true,
).map((tool) => tool.name);

describe('queryableBusinesses / hasMultipleBusinesses', () => {
  it('el principal siempre, las sucursales solo si están activas', () => {
    expect(queryableBusinesses(owner()).map((business) => business.id)).toEqual([10, 11]);
  });

  it('sin negocios (no owner) → vacío y sin multi-negocio', () => {
    expect(queryableBusinesses({})).toEqual([]);
    expect(hasMultipleBusinesses({})).toBe(false);
  });

  it('solo el principal → no es multi-negocio', () => {
    expect(hasMultipleBusinesses(owner([MAIN]))).toBe(false);
  });

  it('principal + solo sucursales suspendidas → no es multi-negocio', () => {
    expect(hasMultipleBusinesses(owner([MAIN, BODEGA]))).toBe(false);
  });

  it('principal + una sucursal activa → multi-negocio', () => {
    expect(hasMultipleBusinesses(owner([MAIN, NORTE]))).toBe(true);
  });
});

describe('resolveBusinessScope', () => {
  it('sin business_id usa el negocio de la sesión, sin marcar negocio', () => {
    expect(resolveBusinessScope(owner(), 11, {}, true)).toEqual({
      ok: true,
      company_id: 11,
      business: null,
    });
  });

  it.each([null, ''])('business_id vacío (%p) = negocio de la sesión', (value) => {
    expect(resolveBusinessScope(owner(), 11, { business_id: value }, true)).toEqual({
      ok: true,
      company_id: 11,
      business: null,
    });
  });

  it('business_id igual al actual = negocio de la sesión (aunque la herramienta no acepte alcance)', () => {
    expect(resolveBusinessScope(owner(), 11, { business_id: 11 }, false)).toEqual({
      ok: true,
      company_id: 11,
      business: null,
    });
  });

  it('otro negocio del owner (también como string) → esa company', () => {
    expect(resolveBusinessScope(owner(), 11, { business_id: 10 }, true)).toEqual({
      ok: true,
      company_id: 10,
      business: MAIN,
    });
    expect(resolveBusinessScope(owner(), 10, { business_id: '11' }, true)).toEqual({
      ok: true,
      company_id: 11,
      business: NORTE,
    });
  });

  it('un id que no es del owner se rechaza (anti-IDOR)', () => {
    const result = resolveBusinessScope(owner(), 10, { business_id: 999 }, true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/no está entre los negocios/);
  });

  it('un empleado (sin negocios) no puede apuntar a otra company', () => {
    const employee: AiToolActor = { ...owner(), isAdmin: false, businesses: [] };
    const result = resolveBusinessScope(employee, 10, { business_id: 11 }, true);
    expect(result.ok).toBe(false);
  });

  it('una sucursal suspendida no se consulta', () => {
    const result = resolveBusinessScope(owner(), 10, { business_id: 12 }, true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/suspendida/);
  });

  it('una herramienta que escribe nunca corre en otro negocio', () => {
    const result = resolveBusinessScope(owner(), 10, { business_id: 11 }, false);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/negocio actual/);
  });

  it.each([0, -3, 1.5, 'norte', Number.NaN, {}])(
    'business_id inválido (%p) se rechaza en vez de convertirse en otro id',
    (value) => {
      const result = resolveBusinessScope(owner(), 10, { business_id: value }, true);
      expect(result.ok).toBe(false);
    },
  );
});

describe('declaraciones con business_id', () => {
  it('withBusinessIdParam agrega el parámetro sin mutar la declaración original', () => {
    const original = tool('get_daily_summary').declaration;
    const before = JSON.stringify(original);
    const scoped = withBusinessIdParam(original);

    expect(scoped.parameters?.properties).toHaveProperty(BUSINESS_ID_PARAM);
    expect(scoped.parameters?.properties).toHaveProperty('date');
    expect(JSON.stringify(original)).toBe(before);
  });

  it('conserva los required de la herramienta', () => {
    const scoped = withBusinessIdParam(tool('search_products').declaration);
    expect(scoped.parameters?.required).toEqual(['query']);
  });

  it('funciona con una herramienta sin propiedades', () => {
    const scoped = withBusinessIdParam(tool('get_treasury_accounts').declaration);
    expect(Object.keys(scoped.parameters?.properties ?? {})).toEqual([BUSINESS_ID_PARAM]);
  });

  it('owner con sucursales: TODAS las de lectura llevan business_id; escritura y consolidado no', () => {
    const declarations = declarationsFor(owner());
    for (const declaration of declarations) {
      const has_param = BUSINESS_ID_PARAM in (declaration.parameters?.properties ?? {});
      expect([declaration.name, has_param]).toEqual([
        declaration.name,
        READ_TOOLS.includes(declaration.name as (typeof READ_TOOLS)[number]),
      ]);
    }
    expect(declarations.map((declaration) => declaration.name)).toContain(
      'get_businesses_overview',
    );
  });

  it('owner SIN sucursales: ni business_id ni consolidado (cero tokens extra)', () => {
    const declarations = declarationsFor(owner([MAIN]));
    expect(declarations.map((declaration) => declaration.name)).not.toContain(
      'get_businesses_overview',
    );
    for (const declaration of declarations) {
      expect(declaration.parameters?.properties ?? {}).not.toHaveProperty(BUSINESS_ID_PARAM);
    }
  });

  it('un empleado nunca recibe business_id ni el consolidado', () => {
    const employee: AiToolActor = {
      isAdmin: false,
      permissions: new Set(['canAccessDashboard', 'canAccessInventory']),
      canViewProfit: true,
      userId: 7,
      is_administrator: false,
    };
    const declarations = declarationsFor(employee);
    expect(declarations.map((declaration) => declaration.name)).not.toContain(
      'get_businesses_overview',
    );
    for (const declaration of declarations) {
      expect(declaration.parameters?.properties ?? {}).not.toHaveProperty(BUSINESS_ID_PARAM);
    }
  });

  it('acceptsBusinessScope: solo herramientas de lectura sobre un negocio', () => {
    expect(acceptsBusinessScope(tool('get_daily_summary'))).toBe(true);
    expect(acceptsBusinessScope(tool('search_suppliers'))).toBe(true);
    expect(acceptsBusinessScope(tool('register_expense'))).toBe(false);
    expect(acceptsBusinessScope(tool('prepare_sale'))).toBe(false);
    expect(acceptsBusinessScope(tool('get_businesses_overview'))).toBe(false);
  });

  it('el consolidado se lista en "qué puede hacer Place" solo con sucursales', () => {
    const names = (actor: AiToolActor): string[] => toolSummariesFor(actor).map((t) => t.name);
    expect(names(owner())).toContain('get_businesses_overview');
    expect(names(owner([MAIN]))).not.toContain('get_businesses_overview');
  });

  it('el consolidado exige además el permiso del dashboard (defensa en profundidad)', () => {
    const overview = tool('get_businesses_overview');
    expect(overview.permission).toBe('canAccessDashboard');
    const not_admin: AiToolActor = { ...owner(), isAdmin: false, permissions: new Set() };
    expect(isToolAllowed(overview, not_admin)).toBe(false);
  });
});

describe('buildBusinessesContext', () => {
  it('no es owner → null (no se habla de sucursales)', () => {
    expect(buildBusinessesContext({}, 10)).toBeNull();
    expect(buildBusinessesContext({ businesses: [] }, 10)).toBeNull();
  });

  it('owner sin sucursales → le dice que solo tiene el principal', () => {
    const lines = buildBusinessesContext({ businesses: [MAIN] }, 10) ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('solo el negocio principal (Surtidor La 21)');
    expect(lines[0]).toContain('NO tiene sucursales');
  });

  it('owner con solo sucursales suspendidas → también "sin sucursales activas"', () => {
    const lines = buildBusinessesContext({ businesses: [MAIN, BODEGA] }, 10) ?? [];
    expect(lines.join('\n')).toContain('NO tiene sucursales activas');
  });

  it('owner con sucursales → una línea compacta por negocio, marcando el actual y las suspendidas', () => {
    const lines = buildBusinessesContext({ businesses: [MAIN, NORTE, BODEGA] }, 11) ?? [];
    expect(lines).toEqual([
      '- TUS NEGOCIOS (todos del mismo dueño):',
      '  #10 Surtidor La 21 (principal)',
      '  #11 Sucursal Norte (sucursal, ACTUAL)',
      '  #12 Bodega Sur (sucursal SUSPENDIDA, no consultable)',
    ]);
  });
});
