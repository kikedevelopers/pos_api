import Big from 'big.js';

import { NoteType } from '@/modules/credit-notes/entities/credit-note.entity';

import {
  calculatePlacePosLineDifferences,
  computeCreditSaleRefund,
  type PlacePosLineDifference,
} from '../actions/update-sale.action';
import type { UpdateSaleLineDto } from '../dto/update-sale.dto';
import {
  buildConsolidatedLines,
  type ConsolidatedLine,
  type NoteSnapshot,
} from '../internal/consolidate-invoice.helper';

/**
 * REGRESIÓN DE PRODUCCIÓN — VTA-1054 (PLASTICOS RICHARD, 16-oct-2026).
 *
 * Un crédito del día anterior se editó 3 veces y la factura terminó con
 * productos DUPLICADOS (J2 ECO PACA ×9 y ×2 cuando el cliente pidió 5; BOLSA
 * 15K ×6 y ×3...). Causa: el delta de edición comparaba solo por `item_id`
 * (`Map.set` → la 2ª línea del mismo producto pisaba a la 1ª) mientras que el
 * consolidado separa las líneas por (producto, precio). Cada guardado volvía a
 * facturar unidades que ya estaban en la factura.
 *
 * Estos tests corren el delta REAL contra el motor de consolidación REAL
 * (`buildConsolidatedLines`) y fijan el invariante: tras aplicar las notas, la
 * factura consolidada es EXACTAMENTE el carrito que se guardó.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────

const P = {
  K1: 13071, // BOLSA MANIJA 1K MILLAR (T15)
  K5: 13068, // BOLSA MANIJA 5K MILLAR (T25)
  K3: 14479, // BOLSA MANIJA 3K MILLAR
  K10: 14487, // BOLSA MANIJA 10K MILLAR
  K15: 14485, // BOLSA MANIJA 15K MILLAR
  K20: 14483, // BOLSA MANIJA 20K MILLAR
  J2: 13872, // J2 ECO PACA *200
};
const COST = 1000;

function liveLine(item_id: number, price: number, quantity: number): ConsolidatedLine {
  const total = new Big(price).times(quantity).toNumber();
  return {
    item_id,
    name: `P${item_id}`,
    cost: COST,
    price,
    quantity,
    total,
    profit: new Big(price).minus(COST).times(quantity).toNumber(),
    margin: 0,
    price_mode: 'fixed',
    price_position: null,
    packaging_value: 1,
    combo_recipe: null,
  };
}

function cartLine(item_id: number, price: number, quantity: number): UpdateSaleLineDto {
  return {
    item_id,
    name: `P${item_id}`,
    cost: COST,
    price,
    quantity,
    total: new Big(price).times(quantity).toNumber(),
  } as UpdateSaleLineDto;
}

/** Notas que emitiría la edición a partir del delta (NC y ND). */
function notesFrom(diff: {
  removedOrReduced: PlacePosLineDifference[];
  addedOrIncreased: PlacePosLineDifference[];
}): NoteSnapshot[] {
  const toNoteLines = (lines: PlacePosLineDifference[]): NoteSnapshot['lines'] =>
    lines.map((l) => ({
      item_id: l.item_id,
      name: l.name,
      cost: l.cost,
      price: l.price,
      quantity: l.quantity,
      total: l.total,
      packaging_value: l.packaging_value ?? 1,
      combo_recipe: null,
    }));
  const notes: NoteSnapshot[] = [];
  if (diff.removedOrReduced.length > 0) {
    notes.push({ id: 1, note_type: NoteType.CREDIT, lines: toNoteLines(diff.removedOrReduced) });
  }
  if (diff.addedOrIncreased.length > 0) {
    notes.push({ id: 2, note_type: NoteType.DEBIT, lines: toNoteLines(diff.addedOrIncreased) });
  }
  return notes;
}

/** Aplica una edición con el motor real y devuelve las líneas vivas resultantes. */
function edit(
  live: ConsolidatedLine[],
  cart: UpdateSaleLineDto[],
): { live: ConsolidatedLine[]; diff: ReturnType<typeof calculatePlacePosLineDifferences> } {
  const diff = calculatePlacePosLineDifferences(live, cart);
  return { live: buildConsolidatedLines(live, notesFrom(diff)), diff };
}

/** Vista canónica (producto|precio → cantidad) para comparar factura vs carrito. */
function view(lines: Array<{ item_id: number; price: number; quantity: number }>) {
  const m = new Map<string, number>();
  for (const l of lines) {
    const key = `${Number(l.item_id)}|${new Big(l.price).toFixed(2)}`;
    m.set(key, new Big(m.get(key) ?? 0).plus(l.quantity).toNumber());
  }
  return Object.fromEntries([...m.entries()].filter(([, q]) => q > 0).sort());
}

/** Cantidad TOTAL facturada de un producto (todas sus líneas). */
function qtyOf(lines: ConsolidatedLine[], itemId: number): number {
  return lines
    .filter((l) => l.item_id === itemId)
    .reduce((s, l) => new Big(s).plus(l.quantity).toNumber(), 0);
}

const totalOf = (lines: Array<{ total: number }>): number =>
  lines.reduce((s, l) => new Big(s).plus(l.total).toNumber(), 0);

// Factura original VTA-1054 (15-oct-2026), tal como está en producción.
const ORIGINAL: ConsolidatedLine[] = [
  liveLine(P.K1, 15700, 10),
  liveLine(P.K5, 36300, 8),
  liveLine(P.K3, 31500, 8),
  liveLine(P.K10, 58300, 5),
  liveLine(P.K15, 60200, 3),
  liveLine(P.K20, 81600, 2),
  liveLine(P.J2, 64000, 3),
];

// ── VTA-1054: la secuencia real de producción ───────────────────────────

describe('Edición de venta — regresión VTA-1054 (productos duplicados)', () => {
  // Edición 1: la usuaria sube cantidades Y cambia el precio de 4 líneas.
  const CART_1 = [
    cartLine(P.K1, 16600, 20),
    cartLine(P.K5, 36300, 8),
    cartLine(P.K3, 31500, 8),
    cartLine(P.K10, 49900, 10),
    cartLine(P.K15, 61200, 6),
    cartLine(P.K20, 81600, 2),
    cartLine(P.J2, 49500, 5),
  ];

  it('edición 1 (cambio de precio + cantidad): la factura queda IGUAL al carrito, sin líneas a precio viejo', () => {
    const { live, diff } = edit(ORIGINAL, CART_1);

    expect(view(live)).toEqual(view(CART_1));
    expect(qtyOf(live, P.J2)).toBe(5);
    expect(qtyOf(live, P.K1)).toBe(20);
    expect(totalOf(live)).toBe(totalOf(CART_1));
    // El cambio de precio se factura: NC de la línea vieja + ND de la nueva.
    expect(diff.removedOrReduced.map((l) => [l.item_id, l.price, l.quantity])).toEqual([
      [P.K1, 15700, 10],
      [P.K10, 58300, 5],
      [P.K15, 60200, 3],
      [P.J2, 64000, 3],
    ]);
  });

  it('guardar la edición SIN tocar nada no emite ninguna nota (antes: ND-006 por 1.013.100)', () => {
    const afterEdit1 = edit(ORIGINAL, CART_1).live;
    // El POS recarga el carrito desde el consolidado: una línea por (producto, precio).
    const reloaded = afterEdit1.map((l) => cartLine(l.item_id, l.price, l.quantity));

    const { live, diff } = edit(afterEdit1, reloaded);

    expect(diff.removedOrReduced).toEqual([]);
    expect(diff.addedOrIncreased).toEqual([]);
    expect(view(live)).toEqual(view(afterEdit1));
  });

  it('producto con DOS líneas a precios distintos: re-guardar no duplica (el bug exacto de producción)', () => {
    // Estado real de VTA-1054 tras ND-005 (lo que dejó el código viejo).
    const twoPrices: ConsolidatedLine[] = [
      liveLine(P.K1, 15700, 10),
      liveLine(P.K1, 16600, 10),
      liveLine(P.K10, 58300, 5),
      liveLine(P.K10, 49900, 5),
      liveLine(P.K15, 60200, 3),
      liveLine(P.K15, 61200, 3),
      liveLine(P.J2, 64000, 3),
      liveLine(P.J2, 49500, 2),
    ];
    const sameCart = twoPrices.map((l) => cartLine(l.item_id, l.price, l.quantity));

    const { live, diff } = edit(twoPrices, sameCart);

    expect(diff.addedOrIncreased).toEqual([]);
    expect(diff.removedOrReduced).toEqual([]);
    expect(qtyOf(live, P.K1)).toBe(20);
    expect(qtyOf(live, P.J2)).toBe(5);
  });

  it('quitar la línea duplicada y dejar J2 en 5 RESTA (antes: ND-007 SUMÓ 821.100)', () => {
    const twoPrices: ConsolidatedLine[] = [
      liveLine(P.K1, 15700, 20),
      liveLine(P.K1, 16600, 10),
      liveLine(P.K10, 58300, 10),
      liveLine(P.K10, 49900, 5),
      liveLine(P.K15, 60200, 6),
      liveLine(P.K15, 61200, 3),
      liveLine(P.J2, 64000, 9),
      liveLine(P.J2, 49500, 2),
    ];
    // Lo que hizo la usuaria: borrar las líneas a precio nuevo y fijar J2 en 5.
    const cart = [
      cartLine(P.K1, 15700, 20),
      cartLine(P.K10, 58300, 10),
      cartLine(P.K15, 60200, 6),
      cartLine(P.J2, 64000, 5),
    ];

    const { live, diff } = edit(twoPrices, cart);

    expect(diff.addedOrIncreased).toEqual([]);
    expect(view(live)).toEqual(view(cart));
    expect(qtyOf(live, P.J2)).toBe(5);
    expect(diff.removedOrReduced.map((l) => [l.item_id, l.price, l.quantity])).toEqual([
      [P.K1, 16600, 10],
      [P.K10, 49900, 5],
      [P.K15, 61200, 3],
      [P.J2, 64000, 4],
      [P.J2, 49500, 2],
    ]);
  });

  it('secuencia completa de 3 ediciones: la cantidad facturada nunca supera lo que hay en el carrito', () => {
    let live = ORIGINAL;
    const carts = [
      CART_1,
      // edición 2: solo sube J2 a 6
      CART_1.map((l) => (l.item_id === P.J2 ? cartLine(P.J2, 49500, 6) : l)),
      // edición 3: J2 de vuelta a 5
      CART_1,
    ];
    for (const cart of carts) {
      live = edit(live, cart).live;
      expect(view(live)).toEqual(view(cart));
      for (const id of Object.values(P)) {
        const inCart = cart.filter((l) => l.item_id === id).reduce((s, l) => s + l.quantity, 0);
        expect(qtyOf(live, id)).toBe(inCart);
      }
    }
  });
});

// ── Casos generales del delta ───────────────────────────────────────────

describe('calculatePlacePosLineDifferences — casos', () => {
  const base = [liveLine(1, 1000, 4), liveLine(2, 2500, 2)];

  it('sin cambios → sin notas', () => {
    const d = calculatePlacePosLineDifferences(base, [cartLine(1, 1000, 4), cartLine(2, 2500, 2)]);
    expect(d).toEqual({ removedOrReduced: [], addedOrIncreased: [] });
  });

  it('aumentar cantidad al mismo precio → ND solo por la diferencia', () => {
    const d = calculatePlacePosLineDifferences(base, [cartLine(1, 1000, 7), cartLine(2, 2500, 2)]);
    expect(d.removedOrReduced).toEqual([]);
    expect(d.addedOrIncreased).toMatchObject([
      { type: 'increased', item_id: 1, price: 1000, quantity: 3, total: 3000 },
    ]);
  });

  it('reducir cantidad → NC por la diferencia, al precio de la línea viva y con su empaque congelado', () => {
    const d = calculatePlacePosLineDifferences(
      [{ ...liveLine(1, 1000, 4), packaging_value: 200 }],
      [cartLine(1, 1000, 1)],
    );
    expect(d.addedOrIncreased).toEqual([]);
    expect(d.removedOrReduced).toMatchObject([
      { type: 'reduced', item_id: 1, price: 1000, quantity: 3, total: 3000, packaging_value: 200 },
    ]);
  });

  it('eliminar una línea → NC por su total vivo exacto', () => {
    const d = calculatePlacePosLineDifferences(base, [cartLine(1, 1000, 4)]);
    expect(d.removedOrReduced).toMatchObject([
      { type: 'removed', item_id: 2, quantity: 2, total: 5000 },
    ]);
  });

  it('producto nuevo → ND por su total', () => {
    const d = calculatePlacePosLineDifferences(base, [
      ...base.map((l) => cartLine(l.item_id, l.price, l.quantity)),
      cartLine(3, 900, 2),
    ]);
    expect(d.addedOrIncreased).toMatchObject([
      { type: 'added', item_id: 3, quantity: 2, total: 1800 },
    ]);
  });

  it('cambiar SOLO el precio → NC de la línea vieja + ND de la nueva (antes se ignoraba)', () => {
    const d = calculatePlacePosLineDifferences(base, [cartLine(1, 1200, 4), cartLine(2, 2500, 2)]);
    expect(d.removedOrReduced).toMatchObject([
      { item_id: 1, price: 1000, quantity: 4, total: 4000 },
    ]);
    expect(d.addedOrIncreased).toMatchObject([
      { item_id: 1, price: 1200, quantity: 4, total: 4800 },
    ]);
  });

  it('el carrito trae el mismo producto y precio en dos líneas → se suman (no se duplica)', () => {
    const d = calculatePlacePosLineDifferences(base, [
      cartLine(1, 1000, 2),
      cartLine(1, 1000, 2),
      cartLine(2, 2500, 2),
    ]);
    expect(d).toEqual({ removedOrReduced: [], addedOrIncreased: [] });
  });

  it('el mismo producto a dos precios en el carrito → dos líneas independientes', () => {
    const d = calculatePlacePosLineDifferences(base, [
      cartLine(1, 1000, 4),
      cartLine(1, 800, 3),
      cartLine(2, 2500, 2),
    ]);
    expect(d.removedOrReduced).toEqual([]);
    expect(d.addedOrIncreased).toMatchObject([
      { type: 'added', item_id: 1, price: 800, quantity: 3 },
    ]);
  });

  it('precios que solo difieren en decimales de redondeo (2 dígitos) son la misma línea', () => {
    const d = calculatePlacePosLineDifferences(
      [liveLine(1, 54.0, 499)],
      [cartLine(1, 54.001, 499)],
    );
    expect(d).toEqual({ removedOrReduced: [], addedOrIncreased: [] });
  });

  it('cantidades decimales (venta por gramos) con Big.js, sin errores de coma flotante', () => {
    const d = calculatePlacePosLineDifferences([liveLine(1, 13.8, 0.3)], [cartLine(1, 13.8, 0.1)]);
    expect(d.removedOrReduced).toMatchObject([{ quantity: 0.2, total: 2.76 }]);
  });

  it('invariante aleatorio: tras aplicar las notas, la factura == carrito (200 ediciones encadenadas)', () => {
    // Generador determinista (LCG) para que el test sea reproducible.
    let seed = 1054;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const PRICES = [1000, 1500, 2000];
    let live: ConsolidatedLine[] = [liveLine(1, 1000, 2)];
    for (let i = 0; i < 200; i += 1) {
      const cart: UpdateSaleLineDto[] = [];
      const lines = 1 + rand(5);
      for (let j = 0; j < lines; j += 1) {
        cart.push(cartLine(1 + rand(3), PRICES[rand(3)], 1 + rand(6)));
      }
      live = edit(live, cart).live;
      expect(view(live)).toEqual(view(cart));
    }
  });
});

// ── Reembolso de una NC sobre venta a crédito ───────────────────────────

describe('computeCreditSaleRefund', () => {
  const b = (n: number): Big => new Big(n);

  it('crédito sin abonos → nunca devuelve', () => {
    expect(computeCreditSaleRefund(0, b(4300), b(4000))).toBe(0);
  });

  it('abono menor que el nuevo total → no devuelve (baja la deuda)', () => {
    expect(computeCreditSaleRefund(2000, b(4300), b(4000))).toBe(0);
  });

  it('abono igual al nuevo total → no devuelve (queda pagado)', () => {
    expect(computeCreditSaleRefund(4300, b(4300), b(4000))).toBe(0);
  });

  it('abono mayor que el nuevo total → devuelve solo el excedente', () => {
    expect(computeCreditSaleRefund(6000, b(4300), b(4000))).toBe(1700);
  });

  it('el reembolso nunca supera el valor de la NC', () => {
    expect(computeCreditSaleRefund(8300, b(0), b(4000))).toBe(4000);
  });

  it('nuevo total negativo se trata como 0', () => {
    expect(computeCreditSaleRefund(500, b(-10), b(800))).toBe(500);
  });

  it('centavos exactos con Big.js', () => {
    expect(computeCreditSaleRefund(100.3, b(100.1), b(5))).toBe(0.2);
  });
});
