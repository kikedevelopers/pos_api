import type { EntityManager } from 'typeorm';

import { NoteType } from '@/modules/credit-notes/entities/credit-note.entity';

import {
  getConsolidatedInvoice,
  stripConsolidatedInternalFields,
  type ConsolidatedInvoice,
} from '../consolidate-invoice.helper';

/**
 * FIX #2 — Unit tests del THREADING de `packaging_value` por la consolidación,
 * con un `EntityManager` mock (sin BD). Verifican que:
 *
 *   - `mapInvoiceLine` cuelga `packaging_value` desde `sale_invoice_line`.
 *   - `applyCreditAdjustment` (NC) NO altera el `packaging_value` de la línea viva.
 *   - `applyDebitAdjustment` (ND) crea la línea nueva con el `packaging_value`
 *     de la `credit_note_line`.
 *   - `stripConsolidatedInternalFields` lo ELIMINA del shape devuelto por HTTP.
 */
describe('consolidate-invoice — threading de packaging_value (FIX #2)', () => {
  interface SeedLine {
    product_id: number;
    description: string;
    unit_cost: number;
    unit_price: number;
    quantity: number;
    total: number;
    profit?: number;
    margin?: number;
    packaging_value: number | null;
    /** FIX #3: opcional para no tocar los casos existentes (legacy = null). */
    combo_recipe?: Array<{ component_product_id: number; quantity: number }> | null;
  }
  interface SeedNote {
    id: number;
    note_type: NoteType;
    lines: SeedLine[];
  }

  function buildManager(opts: { invoiceLines: SeedLine[]; notes?: SeedNote[] }): EntityManager {
    const notes = opts.notes ?? [];
    const noteLineRows = notes.flatMap((n) =>
      n.lines.map((l) => ({
        credit_note_id: String(n.id),
        product_id: String(l.product_id),
        description: l.description,
        unit_cost: l.unit_cost,
        unit_price: l.unit_price,
        quantity: l.quantity,
        total: l.total,
        packaging_value: l.packaging_value,
        combo_recipe: l.combo_recipe ?? null,
      })),
    );

    const managerMock = {
      findOne: jest.fn((entity: { name?: string } | string): Promise<unknown> => {
        const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        if (name === 'SaleInvoice') {
          return Promise.resolve({
            id: '1',
            ticket_type: 'SALE',
            ticket_number: 'T-1',
            sale_number: 'S-1',
            total: 0,
            cost: 0,
            profit: 0,
            margin: 0,
            customer_name: 'CONSUMIDOR FINAL',
            customer_id: null,
          });
        }
        return Promise.resolve(null);
      }),
      find: jest.fn((entity: { name?: string } | string): Promise<unknown[]> => {
        const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        if (name === 'SaleInvoiceLine') {
          return Promise.resolve(
            opts.invoiceLines.map((l) => ({
              product_id: String(l.product_id),
              description: l.description,
              unit_cost: l.unit_cost,
              unit_price: l.unit_price,
              quantity: l.quantity,
              total: l.total,
              profit: l.profit ?? 0,
              margin: l.margin ?? 0,
              packaging_value: l.packaging_value,
              combo_recipe: l.combo_recipe ?? null,
            })),
          );
        }
        if (name === 'CreditNote') {
          return Promise.resolve(notes.map((n) => ({ id: String(n.id), note_type: n.note_type })));
        }
        return Promise.resolve([]);
      }),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(noteLineRows),
      })),
    };
    return managerMock as unknown as EntityManager;
  }

  it('mapInvoiceLine cuelga packaging_value (incluido null legacy) desde la línea original', async () => {
    const manager = buildManager({
      invoiceLines: [
        {
          product_id: 100,
          description: 'A',
          unit_cost: 1,
          unit_price: 2,
          quantity: 1,
          total: 2,
          packaging_value: 10,
        },
        {
          product_id: 101,
          description: 'B',
          unit_cost: 1,
          unit_price: 2,
          quantity: 1,
          total: 2,
          packaging_value: null,
        },
      ],
    });

    const result = await getConsolidatedInvoice(manager, 1, 1);
    const byId = new Map(result!.lines.map((l) => [l.item_id, l]));
    expect(byId.get(100)?.packaging_value).toBe(10);
    expect(byId.get(101)?.packaging_value).toBeNull();
  });

  it('REGRESIÓN: 2 líneas originales del MISMO product_id se CONSOLIDAN (suma qty/total, conserva packaging_value)', async () => {
    // Antes la 2ª línea pisaba a la 1ª → sub-retorno de inventario y NC menor.
    // Ahora se suman: qty 2+3=5, total 20+30=50. El packaging_value se conserva
    // del primero (10), aunque el segundo venga null.
    const manager = buildManager({
      invoiceLines: [
        {
          product_id: 100,
          description: 'Dup',
          unit_cost: 4,
          unit_price: 10,
          quantity: 2,
          total: 20,
          profit: 12, // (10 − 4) × 2
          packaging_value: 10,
        },
        {
          product_id: 100,
          description: 'Dup',
          unit_cost: 4,
          unit_price: 10,
          quantity: 3,
          total: 30,
          profit: 18, // (10 − 4) × 3
          packaging_value: null,
        },
      ],
    });

    const result = await getConsolidatedInvoice(manager, 1, 1);
    expect(result!.lines).toHaveLength(1);
    const line = result!.lines[0];
    expect(line.item_id).toBe(100);
    expect(line.quantity).toBe(5);
    expect(line.total).toBe(50);
    expect(line.packaging_value).toBe(10); // conservado del primero
    // La ganancia se SUMA de cada línea (12 + 18) en vez de recalcularse con un
    // solo precio: dos líneas del mismo producto pueden llevar precios distintos.
    expect(line.profit).toBe(30);
    // El total consolidado refleja la suma (no la última línea sola).
    expect(result!.total).toBe(50);
  });

  it('applyDebitAdjustment (ND) crea la línea NUEVA con el packaging_value de la credit_note_line', async () => {
    const manager = buildManager({
      invoiceLines: [
        {
          product_id: 100,
          description: 'A',
          unit_cost: 1,
          unit_price: 2,
          quantity: 1,
          total: 2,
          packaging_value: 10,
        },
      ],
      notes: [
        {
          id: 50,
          note_type: NoteType.DEBIT,
          lines: [
            {
              product_id: 200,
              description: 'Nuevo',
              unit_cost: 3,
              unit_price: 5,
              quantity: 2,
              total: 10,
              packaging_value: 7,
            },
          ],
        },
      ],
    });

    const result = await getConsolidatedInvoice(manager, 1, 1);
    const byId = new Map(result!.lines.map((l) => [l.item_id, l]));
    expect(byId.get(100)?.packaging_value).toBe(10); // original intacto
    expect(byId.get(200)?.packaging_value).toBe(7); // nuevo desde la ND
  });

  it('applyCreditAdjustment (NC) reduce cantidad pero CONSERVA el packaging_value de la línea viva', async () => {
    const manager = buildManager({
      invoiceLines: [
        {
          product_id: 100,
          description: 'A',
          unit_cost: 1,
          unit_price: 2,
          quantity: 5,
          total: 10,
          packaging_value: 10,
        },
      ],
      notes: [
        {
          id: 60,
          note_type: NoteType.CREDIT,
          lines: [
            {
              product_id: 100,
              description: 'A',
              unit_cost: 1,
              unit_price: 2,
              quantity: 2,
              total: 4,
              packaging_value: 10,
            },
          ],
        },
      ],
    });

    const result = await getConsolidatedInvoice(manager, 1, 1);
    const line = result!.lines.find((l) => l.item_id === 100);
    expect(line?.quantity).toBe(3); // 5 - 2
    expect(line?.packaging_value).toBe(10); // conservado
  });

  it('stripConsolidatedInternalFields ELIMINA packaging_value sin alterar el resto', () => {
    const invoice: ConsolidatedInvoice = {
      id: 1,
      ticketType: 'SALE' as ConsolidatedInvoice['ticketType'],
      ticketNumber: 'T-1',
      saleNumber: 'S-1',
      total: 10,
      cost: 4,
      profit: 6,
      margin: 60,
      customerName: 'CONSUMIDOR FINAL',
      customerId: null,
      lines: [
        {
          item_id: 100,
          name: 'A',
          cost: 1,
          price: 2,
          quantity: 5,
          total: 10,
          profit: 5,
          margin: 50,
          price_mode: 'fixed',
          price_position: null,
          packaging_value: 10,
        },
      ],
    };

    const stripped = stripConsolidatedInternalFields(invoice);
    expect(stripped.lines[0]).not.toHaveProperty('packaging_value');
    // El resto del shape se mantiene intacto.
    expect(stripped.lines[0]).toMatchObject({ item_id: 100, name: 'A', quantity: 5, total: 10 });
    expect(stripped.total).toBe(10);
    // Garantía de contrato HTTP: el JSON serializado NO contiene la llave.
    expect(JSON.stringify(stripped)).not.toContain('packaging_value');
  });
  /**
   * FIX #3 — Mismo threading para la receta congelada del combo. Si se pierde
   * en cualquier tramo de la consolidación, la NC por edición y la anulación
   * caen a la receta VIGENTE y corrompen el stock en silencio.
   */
  describe('threading de combo_recipe (FIX #3)', () => {
    const RECIPE = [
      { component_product_id: 1, quantity: 25 },
      { component_product_id: 2, quantity: 30 },
    ];

    it('mapInvoiceLine cuelga la receta congelada de la línea original', async () => {
      const manager = buildManager({
        invoiceLines: [
          {
            product_id: 9,
            description: 'COMBO MIX',
            unit_cost: 1,
            unit_price: 2,
            quantity: 3,
            total: 6,
            packaging_value: null,
            combo_recipe: RECIPE,
          },
        ],
      });

      const result = await getConsolidatedInvoice(manager, 1, 1);
      expect(result!.lines[0].combo_recipe).toEqual(RECIPE);
    });

    it('una línea que no vende un combo la expone null', async () => {
      const manager = buildManager({
        invoiceLines: [
          {
            product_id: 100,
            description: 'A',
            unit_cost: 1,
            unit_price: 2,
            quantity: 1,
            total: 2,
            packaging_value: 10,
          },
        ],
      });

      const result = await getConsolidatedInvoice(manager, 1, 1);
      expect(result!.lines[0].combo_recipe).toBeNull();
    });

    it('una NC parcial NO altera la receta de la línea viva', async () => {
      const manager = buildManager({
        invoiceLines: [
          {
            product_id: 9,
            description: 'COMBO MIX',
            unit_cost: 1,
            unit_price: 2,
            quantity: 5,
            total: 10,
            packaging_value: null,
            combo_recipe: RECIPE,
          },
        ],
        notes: [
          {
            id: 50,
            note_type: NoteType.CREDIT,
            lines: [
              {
                product_id: 9,
                description: 'COMBO MIX',
                unit_cost: 1,
                unit_price: 2,
                quantity: 2,
                total: 4,
                packaging_value: null,
                combo_recipe: RECIPE,
              },
            ],
          },
        ],
      });

      const result = await getConsolidatedInvoice(manager, 1, 1);
      expect(result!.lines[0].quantity).toBe(3);
      expect(result!.lines[0].combo_recipe).toEqual(RECIPE);
    });

    it('una ND crea la línea nueva heredando la receta de la nota', async () => {
      const manager = buildManager({
        invoiceLines: [
          {
            product_id: 100,
            description: 'A',
            unit_cost: 1,
            unit_price: 2,
            quantity: 1,
            total: 2,
            packaging_value: 10,
          },
        ],
        notes: [
          {
            id: 60,
            note_type: NoteType.DEBIT,
            lines: [
              {
                product_id: 9,
                description: 'COMBO MIX',
                unit_cost: 1,
                unit_price: 2,
                quantity: 4,
                total: 8,
                packaging_value: null,
                combo_recipe: RECIPE,
              },
            ],
          },
        ],
      });

      const result = await getConsolidatedInvoice(manager, 1, 1);
      const combo = result!.lines.find((l) => l.item_id === 9);
      expect(combo?.combo_recipe).toEqual(RECIPE);
    });

    it('dos líneas del MISMO combo se fusionan conservando la receta', async () => {
      const line = {
        product_id: 9,
        description: 'COMBO MIX',
        unit_cost: 1,
        unit_price: 2,
        quantity: 2,
        total: 4,
        packaging_value: null,
        combo_recipe: RECIPE,
      };
      const manager = buildManager({ invoiceLines: [line, { ...line }] });

      const result = await getConsolidatedInvoice(manager, 1, 1);
      expect(result!.lines).toHaveLength(1);
      expect(result!.lines[0].quantity).toBe(4);
      expect(result!.lines[0].combo_recipe).toEqual(RECIPE);
    });

    it('la receta NUNCA sale por HTTP (contrato de respuesta intacto)', () => {
      const invoice = {
        id: 1,
        ticketType: 'SALE' as ConsolidatedInvoice['ticketType'],
        ticketNumber: 'T-1',
        saleNumber: 'S-1',
        total: 10,
        cost: 5,
        profit: 5,
        margin: 50,
        customerName: 'CONSUMIDOR FINAL',
        customerId: null,
        lines: [
          {
            item_id: 9,
            name: 'COMBO MIX',
            cost: 1,
            price: 2,
            quantity: 5,
            total: 10,
            profit: 5,
            margin: 50,
            price_mode: 'fixed' as const,
            price_position: null,
            packaging_value: null,
            combo_recipe: RECIPE,
          },
        ],
      };

      const stripped = stripConsolidatedInternalFields(invoice);
      expect(stripped.lines[0]).not.toHaveProperty('combo_recipe');
      expect(stripped.lines[0]).toMatchObject({ item_id: 9, quantity: 5 });
      expect(JSON.stringify(stripped)).not.toContain('combo_recipe');
    });
  });

  /**
   * Un producto vendido POR MONTO se registra como `1 × 27.000`. Si después se
   * le añade producto, la nota débito llega en la unidad real (`499 × 54`).
   * Fusionar las dos por `product_id` y recalcular `precio × cantidad` daba
   * `27.000 × 500` = 13.500.000 en una venta de 53.946.
   *
   * Las cifras de estos tests son las de las dos ventas reales que salieron
   * afectadas (PED-2607 y PED-112).
   */
  describe('consolidado con precios unitarios distintos en el mismo producto', () => {
    it('la ND en otra unidad NO se fusiona con la venta por monto', async () => {
      const manager = buildManager({
        invoiceLines: [
          {
            product_id: 47614,
            description: 'ANIS ESTRELLADO X GRAMO',
            unit_cost: 46.81,
            unit_price: 27000,
            quantity: 1,
            total: 27000,
            profit: 26953.19,
            packaging_value: null,
          },
        ],
        notes: [
          {
            id: 15,
            note_type: NoteType.DEBIT,
            lines: [
              {
                product_id: 47614,
                description: 'ANIS ESTRELLADO X GRAMO',
                unit_cost: 46.81,
                unit_price: 54,
                quantity: 499,
                total: 26946,
                packaging_value: null,
              },
            ],
          },
        ],
      });

      const result = await getConsolidatedInvoice(manager, 1, 1);

      // Dos líneas: es lo que de verdad pasó en la venta.
      expect(result!.lines).toHaveLength(2);
      // Y el total es el consolidado real, no trece millones y medio.
      expect(result!.total).toBe(53946);
      expect(result!.total).not.toBe(13500000);
    });

    it('PED-112: el mismo caso con otras cifras da 7.968, no 500.000', async () => {
      const manager = buildManager({
        invoiceLines: [
          {
            product_id: 5001,
            description: 'CONDIMENTO PARA CARNES X GRAMO',
            unit_cost: 20,
            unit_price: 4000,
            quantity: 1,
            total: 4000,
            profit: 3980,
            packaging_value: null,
          },
        ],
        notes: [
          {
            id: 2,
            note_type: NoteType.DEBIT,
            lines: [
              {
                product_id: 5001,
                description: 'CONDIMENTO PARA CARNES X GRAMO',
                unit_cost: 20,
                unit_price: 32,
                quantity: 124,
                total: 3968,
                packaging_value: null,
              },
            ],
          },
        ],
      });

      const result = await getConsolidatedInvoice(manager, 1, 1);

      expect(result!.total).toBe(7968);
      expect(result!.total).not.toBe(500000);
    });

    it('la ND al MISMO precio sí se acumula en una sola línea', async () => {
      // El caso normal no puede haberse roto por el arreglo: añadir 3 unidades
      // más del mismo producto al mismo precio sigue siendo la misma línea.
      const manager = buildManager({
        invoiceLines: [
          {
            product_id: 100,
            description: 'Arroz',
            unit_cost: 4,
            unit_price: 10,
            quantity: 2,
            total: 20,
            profit: 12,
            packaging_value: null,
          },
        ],
        notes: [
          {
            id: 5,
            note_type: NoteType.DEBIT,
            lines: [
              {
                product_id: 100,
                description: 'Arroz',
                unit_cost: 4,
                unit_price: 10,
                quantity: 3,
                total: 30,
                packaging_value: null,
              },
            ],
          },
        ],
      });

      const result = await getConsolidatedInvoice(manager, 1, 1);

      expect(result!.lines).toHaveLength(1);
      expect(result!.lines[0].quantity).toBe(5);
      expect(result!.total).toBe(50);
      expect(result!.lines[0].profit).toBe(30);
    });

    it('la NC en otra unidad descuenta el VALOR, no precio × cantidad', async () => {
      // Sin el descuento por valor, quitar 100 gramos de una venta por monto
      // recalcularía con el precio del monto y dejaría un total inventado.
      const manager = buildManager({
        invoiceLines: [
          {
            product_id: 47614,
            description: 'ANIS ESTRELLADO X GRAMO',
            unit_cost: 46.81,
            unit_price: 27000,
            quantity: 500,
            total: 27000,
            profit: 3595,
            packaging_value: null,
          },
        ],
        notes: [
          {
            id: 20,
            note_type: NoteType.CREDIT,
            lines: [
              {
                product_id: 47614,
                description: 'ANIS ESTRELLADO X GRAMO',
                unit_cost: 46.81,
                unit_price: 54,
                quantity: 100,
                total: 5400,
                packaging_value: null,
              },
            ],
          },
        ],
      });

      const result = await getConsolidatedInvoice(manager, 1, 1);

      expect(result!.lines).toHaveLength(1);
      expect(result!.lines[0].quantity).toBe(400);
      expect(result!.total).toBe(21600); // 27.000 − 5.400
    });

    it('la NC que se lleva toda la cantidad elimina la línea', async () => {
      // La anulación total tiene que dejar el consolidado en cero: si la línea
      // sobreviviera, la venta seguiría contando en los informes.
      const manager = buildManager({
        invoiceLines: [
          {
            product_id: 100,
            description: 'Arroz',
            unit_cost: 4,
            unit_price: 10,
            quantity: 2,
            total: 20,
            profit: 12,
            packaging_value: null,
          },
        ],
        notes: [
          {
            id: 21,
            note_type: NoteType.CREDIT,
            lines: [
              {
                product_id: 100,
                description: 'Arroz',
                unit_cost: 4,
                unit_price: 10,
                quantity: 2,
                total: 20,
                packaging_value: null,
              },
            ],
          },
        ],
      });

      const result = await getConsolidatedInvoice(manager, 1, 1);

      expect(result!.lines).toHaveLength(0);
      expect(result!.total).toBe(0);
    });
  });
});
