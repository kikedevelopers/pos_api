import {
  AI_TOOLS,
  declarationsFor,
  findTool,
  isToolAllowed,
  salesScopeUserId,
  stripProfitFields,
  type AiToolActor,
} from '../internal/tool-catalog';

const actor = (overrides: Partial<AiToolActor> = {}): AiToolActor => ({
  isAdmin: false,
  permissions: new Set<string>(),
  canViewProfit: true,
  userId: 42,
  ...overrides,
});

describe('catálogo de herramientas', () => {
  it('no tiene nombres duplicados y cada declaración coincide con su nombre', () => {
    const names = AI_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of AI_TOOLS) {
      expect(tool.declaration.name).toBe(tool.name);
      expect(tool.declaration.description.length).toBeGreaterThan(20);
    }
  });

  it('findTool devuelve undefined para nombres inventados', () => {
    expect(findTool('drop_database')).toBeUndefined();
    expect(findTool('get_daily_summary')?.label).toBe('Resumen del día');
  });
});

describe('isToolAllowed', () => {
  it('el admin puede usar todas', () => {
    const admin = actor({ isAdmin: true });
    expect(AI_TOOLS.every((tool) => isToolAllowed(tool, admin))).toBe(true);
  });

  it('el empleado solo usa las de los permisos que tiene', () => {
    const cajero = actor({ permissions: new Set(['canAccessInventory']) });
    const allowed = (name: string): boolean => {
      const tool = findTool(name);
      if (!tool) {
        throw new Error(`Herramienta inexistente: ${name}`);
      }
      return isToolAllowed(tool, cajero);
    };

    expect(allowed('search_products')).toBe(true);
    expect(allowed('get_daily_summary')).toBe(false);
    expect(allowed('get_treasury_accounts')).toBe(false);
  });

  it('declarationsFor solo declara lo permitido', () => {
    const declarations = declarationsFor(actor({ permissions: new Set(['canAccessCustomers']) }));
    expect(declarations.map((declaration) => declaration.name)).toEqual(['search_customers']);
  });

  it('un empleado sin permisos no recibe ninguna herramienta', () => {
    expect(declarationsFor(actor())).toEqual([]);
  });
});

describe('salesScopeUserId', () => {
  it('el owner ve las ventas de todo el equipo', () => {
    expect(salesScopeUserId(actor({ isAdmin: true }))).toBeNull();
  });

  it('el empleado CON canViewAllSales (p. ej. Cajero) las ve todas', () => {
    expect(salesScopeUserId(actor({ permissions: new Set(['canViewAllSales']) }))).toBeNull();
  });

  it('el empleado SIN canViewAllSales (p. ej. Vendedor) solo ve las suyas', () => {
    expect(salesScopeUserId(actor({ userId: 7 }))).toBe(7);
  });
});

describe('stripProfitFields', () => {
  const payload = {
    date: '2026-07-28',
    profit: 100,
    surplus: 50,
    sales: { total: 300, cost: 200, margin: 33 },
    products: [
      { name: 'Arroz', stock: 4, totalProfit: 10, avgMargin: 12 },
      { name: 'Aceite', stock: 2, totalProfit: 5, avgMargin: 8 },
    ],
  };

  it('devuelve el objeto intacto si el usuario ve ganancias', () => {
    expect(stripProfitFields(payload, true)).toBe(payload);
  });

  it('elimina costo, ganancia y margen en cualquier nivel', () => {
    const stripped = stripProfitFields(payload, false) as Record<string, unknown>;

    expect(stripped).not.toHaveProperty('profit');
    expect(stripped).not.toHaveProperty('surplus');
    expect(stripped.sales).toEqual({ total: 300 });
    expect(stripped.products).toEqual([
      { name: 'Arroz', stock: 4 },
      { name: 'Aceite', stock: 2 },
    ]);
    expect(stripped.date).toBe('2026-07-28');
  });

  it('respeta valores primitivos y nulos', () => {
    expect(stripProfitFields(null, false)).toBeNull();
    expect(stripProfitFields(7, false)).toBe(7);
    expect(stripProfitFields('hola', false)).toBe('hola');
  });
});
