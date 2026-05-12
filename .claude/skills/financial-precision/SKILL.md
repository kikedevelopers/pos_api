---
name: financial-precision
description: Precisión monetaria con Big.js, transformer para columnas numeric, cálculo de ganancia/margen, IVA, totales consolidados y reglas anti-bug de punto flotante. Cargar al diseñar cualquier servicio que toque dinero, IVA, márgenes o totales.
---

# Precisión financiera con Big.js

## Por qué

JavaScript `number` es IEEE 754 binary64. `0.1 + 0.2 = 0.30000000000000004`. En un POS donde el ticket impreso debe cuadrar con la caja al céntimo, esto se traduce en descuadres reales.

**Convención del proyecto**: todo cálculo monetario o de cantidades pasa por `Big.js`. Las columnas `numeric` de Postgres se cargan como string vía transformer y se convierten a `Big` para operar.

PlacePos usa el mismo patrón en `src/main/utils/precision.ts`. **Espejamos sus nombres** para minimizar fricción cognitiva entre repos.

## Setup global

### Dependencia

```json
"big.js": "^6.2.1"
```

### Configuración global (en `main.ts`, antes de `bootstrap()`)

```typescript
import Big from 'big.js';

Big.RM = Big.roundHalfUp;
Big.DP = 10;  // dígitos internos antes de redondeo final
```

### Transformer para columnas numeric

`src/common/utils/numeric-transformer.ts`:

```typescript
import Big from 'big.js';

export const NumericTransformer = {
  to(value: string | number | Big | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return new Big(value).toString();
  },
  from(value: string | null): number | null {
    if (value === null || value === undefined) return null;
    return Number(value);
  },
};
```

Uso en entidad:

```typescript
@Column('numeric', { precision: 15, scale: 2, transformer: NumericTransformer })
total: number;

@Column('numeric', { precision: 15, scale: 4, transformer: NumericTransformer })
quantity: number;
```

El `from` devuelve `number` para que el JSON salga limpio. Pero **dentro del servicio**, antes de operar, conviertes a `Big` con `toBig(entity.total)`.

## Helpers (`src/common/utils/precision.ts`)

Espejo de `placepos/src/main/utils/precision.ts`:

```typescript
import Big from 'big.js';

export function toBig(value: unknown): Big {
  if (value === null || value === undefined) return new Big(0);
  return new Big(value as Big.BigSource);
}

export function preciseNumber(value: unknown, scale = 2): number {
  return Number(toBig(value).round(scale).toString());
}

export function calculateProfit(salePrice: unknown, cost: unknown): number {
  return preciseNumber(toBig(salePrice).minus(toBig(cost)), 2);
}

export function calculateMargin(salePrice: unknown, cost: unknown): number {
  const price = toBig(salePrice);
  if (price.eq(0)) return 0;
  const profit = price.minus(toBig(cost));
  return preciseNumber(profit.div(price).times(100), 4);
}
```

Mantén estos nombres **idénticos** a PlacePos para que cualquier dev se mueva entre repos sin recordar.

## Precisión por tipo de campo

| Campo | precision | scale | Justificación |
|---|---|---|---|
| Montos finales (`total`, `subtotal`, `iva_amount`, `profit`, `cost`, `price`, `amount`, `balance`) | 15 | 2 | Dos decimales para cualquier moneda no-crypto. |
| Cantidades (`stock`, `quantity`, `unit_qty`, `packaging_qty`, `packaging_value`) | 15 | 4 | Permite fraccionar (1.5 kg, 0.25 L). |
| Márgenes (`margin`, `iva_rate`) | 15 | 4 | Porcentajes con precisión fina. |

## IVA (solo en compras)

PlacePos maneja IVA discriminado solo en `purchase_lines`. En ventas, el precio se asume final.

Fórmula en `PurchaseLine`:

```typescript
const subtotal = toBig(unit_price).times(unit_qty);
const iva_amount = subtotal.times(toBig(iva_rate).div(100));
const total = subtotal.plus(iva_amount);

return {
  subtotal: preciseNumber(subtotal, 2),
  iva_amount: preciseNumber(iva_amount, 2),
  total: preciseNumber(total, 2),
};
```

**Nunca**:
```typescript
const total = unit_price * unit_qty * (1 + iva_rate / 100);  // ❌
```

## Profit y Margin

Para cada `SaleInvoiceLine`:

```typescript
const profit = calculateProfit(line.price, line.cost);            // 2 decimales
const margin = calculateMargin(line.price, line.cost);            // 4 decimales (%)
```

Total profit de la venta = suma con Big.js:

```typescript
const totalProfit = lines.reduce(
  (acc, l) => acc.plus(toBig(l.profit)),
  toBig(0),
);
sale.profit = preciseNumber(totalProfit, 2);
```

## Total consolidado (venta + notas)

```typescript
const credits = notes
  .filter(n => n.note_type === 'CREDIT')
  .reduce((acc, n) => acc.plus(toBig(n.total)), toBig(0));

const debits = notes
  .filter(n => n.note_type === 'DEBIT')
  .reduce((acc, n) => acc.plus(toBig(n.total)), toBig(0));

const consolidated = toBig(sale.total).minus(credits).plus(debits);
return preciseNumber(consolidated, 2);
```

## Validación de input monetario en DTOs

Acepta **string** validado, no `number`:

```typescript
import { IsString, Matches } from 'class-validator';

export class CreatePaymentDto {
  @ApiProperty({ example: '150.50' })
  @IsString()
  @Matches(/^\d+(\.\d{1,4})?$/, { message: 'amount debe ser un decimal positivo con hasta 4 decimales' })
  amount: string;
}
```

En el servicio:

```typescript
const amount = new Big(dto.amount);
if (amount.lte(0)) throw new UnprocessableEntityException('amount debe ser > 0');
```

Razón: si el cliente envía `number`, el JSON parser pudo redondear `150.555555…` a `150.5555555555556`. Con `string` el dato llega tal cual el cliente lo escribió.

## Redondeo

- Modo: `ROUND_HALF_UP` (estándar comercial — `1.005 → 1.01`).
- Internamente Big.js mantiene 10 dígitos. Al persistir o exponer, redondea a la `scale` de la columna con `preciseNumber(value, scale)`.
- **Nunca** redondees en pasos intermedios. Solo al final.

## Reglas anti-bug

1. **Nunca** sumes/multipliques `number` directo en lógica financiera. `toBig()` primero, siempre.
2. **Nunca** compares montos con `===`. Usa `b1.eq(b2)`, `b1.gt(b2)`, etc.
3. **Nunca** uses `parseFloat` sobre input del cliente. Usa `new Big(...)` con validación previa.
4. **Nunca** persistas un resultado sin redondear a la `scale` de la columna.
5. **Tests obligatorios**: incluye `0.1 + 0.2`, `0.05 * 100 * 100`, descuentos compuestos que lleven total a `0.00`, y casos de redondeo `1.005`.

## Casos de borde a auditar

- **Total negativo después de descuentos**: rechazar con 422.
- **Descuento > total**: rechazar con 422.
- **Precio o costo 0 con cantidad positiva**: permitir pero alertar en log (puede ser regalo o producto promocional).
- **Cantidad 0**: rechazar con 400.
- **Margen sobre precio 0**: devolver 0, no `Infinity` ni `NaN`. Ya manejado en `calculateMargin`.
- **String numérico mal formado**: rechazar con 400 en el ValidationPipe (regex en DTO).
