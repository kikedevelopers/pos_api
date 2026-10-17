import {
  AI_TOOLS,
  declarationsFor,
  findTool,
  isToolAllowed,
  salesScopeUserId,
  stripProfitFields,
  toolSummariesFor,
  type AiToolActor,
} from '../internal/tool-catalog';

const actor = (overrides: Partial<AiToolActor> = {}): AiToolActor => ({
  isAdmin: false,
  permissions: new Set<string>(),
  canViewProfit: true,
  userId: 42,
  is_administrator: false,
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

describe('herramientas que ESCRIBEN gastos (solo administrador)', () => {
  const WRITE_TOOLS = ['register_expense', 'void_expense', 'confirm_expense_action'];
  const toolNamed = (name: string): NonNullable<ReturnType<typeof findTool>> => {
    const tool = findTool(name);
    if (!tool) {
      throw new Error(`Herramienta inexistente: ${name}`);
    }
    return tool;
  };
  const allowedFor = (who: AiToolActor): string[] =>
    WRITE_TOOLS.filter((name) => isToolAllowed(toolNamed(name), who));

  it('las 3 existen, exigen rol administrador y el permiso de Gastos', () => {
    for (const name of WRITE_TOOLS) {
      const tool = findTool(name);
      expect(tool?.requires_administrator).toBe(true);
      expect(tool?.permission).toBe('canAccessExpenses');
    }
  });

  it('el owner/superadmin las tiene todas', () => {
    expect(allowedFor(actor({ isAdmin: true }))).toEqual(WRITE_TOOLS);
  });

  it('el empleado con rol Administrador las tiene', () => {
    expect(
      allowedFor(actor({ is_administrator: true, permissions: new Set(['canAccessExpenses']) })),
    ).toEqual(WRITE_TOOLS);
  });

  it('un Cajero con permiso de Gastos NO puede escribir (el permiso no basta sin el rol)', () => {
    const cajero = actor({ permissions: new Set(['canAccessExpenses', 'canViewAllSales']) });
    expect(allowedFor(cajero)).toEqual([]);
    // …pero sí sigue consultando el resumen de gastos.
    expect(isToolAllowed(toolNamed('get_expenses_summary'), cajero)).toBe(true);
  });

  it('fail-closed: si el flag de administrador no viene, no se habilitan', () => {
    const legacy = {
      isAdmin: false,
      permissions: new Set(['canAccessExpenses']),
      canViewProfit: true,
      userId: 1,
    } as unknown as AiToolActor;
    expect(allowedFor(legacy)).toEqual([]);
  });

  it('el rol Administrador sin el permiso de Gastos tampoco (ambas condiciones)', () => {
    expect(allowedFor(actor({ is_administrator: true }))).toEqual([]);
  });

  it('el paso interno de confirmación no se lista en "qué puede hacer Place"', () => {
    const names = toolSummariesFor(actor({ isAdmin: true })).map((tool) => tool.name);
    expect(names).toContain('register_expense');
    expect(names).toContain('void_expense');
    expect(names).not.toContain('confirm_expense_action');
    // …aunque el modelo sí la tiene declarada.
    expect(declarationsFor(actor({ isAdmin: true })).map((d) => d.name)).toContain(
      'confirm_expense_action',
    );
  });

  it('confirm_expense_action no recibe argumentos: ejecuta solo lo preparado', () => {
    expect(findTool('confirm_expense_action')?.declaration.parameters?.properties).toEqual({});
  });
});

describe('herramientas que CREAN pedidos (solo administrador)', () => {
  const SALE_TOOLS = ['prepare_sale', 'confirm_sale'];
  const allowedFor = (who: AiToolActor): string[] =>
    SALE_TOOLS.filter((name) => {
      const tool = findTool(name);
      if (!tool) {
        throw new Error(`Herramienta inexistente: ${name}`);
      }
      return isToolAllowed(tool, who);
    });

  it('existen, exigen rol administrador y el permiso del POS, y no exponen ganancias', () => {
    for (const name of SALE_TOOLS) {
      const tool = findTool(name);
      expect(tool?.requires_administrator).toBe(true);
      expect(tool?.permission).toBe('canAccessPOS');
      expect(tool?.exposesProfit).toBe(false);
    }
  });

  it('el owner/superadmin y el rol Administrador con POS las tienen', () => {
    expect(allowedFor(actor({ isAdmin: true }))).toEqual(SALE_TOOLS);
    expect(
      allowedFor(actor({ is_administrator: true, permissions: new Set(['canAccessPOS']) })),
    ).toEqual(SALE_TOOLS);
  });

  it('un Cajero o Vendedor con acceso al POS NO (el permiso no basta sin el rol)', () => {
    const vendedor = actor({
      permissions: new Set(['canAccessPOS', 'canAccessInventory', 'canAccessCustomers']),
    });
    expect(allowedFor(vendedor)).toEqual([]);
    expect(declarationsFor(vendedor).map((d) => d.name)).not.toContain('prepare_sale');
  });

  it('el rol Administrador sin el permiso del POS tampoco (ambas condiciones)', () => {
    expect(allowedFor(actor({ is_administrator: true }))).toEqual([]);
  });

  it('confirm_sale no recibe argumentos y no se lista; prepare_sale sí se lista', () => {
    expect(findTool('confirm_sale')?.declaration.parameters?.properties).toEqual({});
    const names = toolSummariesFor(actor({ isAdmin: true })).map((tool) => tool.name);
    expect(names).toContain('prepare_sale');
    expect(names).not.toContain('confirm_sale');
  });

  it('prepare_sale declara las líneas como arreglo de objetos con query/cantidad/precio', () => {
    const properties = findTool('prepare_sale')?.declaration.parameters?.properties as Record<
      string,
      { type: string; items?: { type: string; properties: Record<string, unknown> } }
    >;
    expect(properties.items.type).toBe('array');
    expect(Object.keys(properties.items.items?.properties ?? {})).toEqual(
      expect.arrayContaining(['query', 'alternatives', 'product_id', 'quantity', 'unit_price']),
    );
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
