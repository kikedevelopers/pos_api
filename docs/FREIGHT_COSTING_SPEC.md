Tengo confirmado el código real de placepos. Los dos análisis ya cubren pos_api con precisión. Procedo a producir el spec.

```markdown
# SPEC DE IMPLEMENTACIÓN — Prorrateo de flete al costo del producto (placepos ↔ pos_api)

> Estado base confirmado en código:
> - **placepos** YA tiene promedio ponderado completo (`recalculateProductCosts`, `computePurchaseUnitMinCost`, `weightedAverageCost`, propagación padre/hijo, historial) pero **NO prorratea flete** y usa **`line.subtotal`** (sin IVA).
> - **pos_api** NO recalcula costo en ninguna parte del ciclo de compra. Las tablas `product_cost_history` / `product_price_history` existen vacías (multi-tenant, `company_id` NOT NULL). Hay que **portar toda la maquinaria + flete**.
> - El **flete al costo es funcionalidad nueva en AMBOS repos** ⇒ por la regla de paridad, se implementa en placepos y pos_api en la misma tarea con la misma fórmula.
> - Todo cálculo con **Big.js** (regla del proyecto).

---

## 0. Decisión de base de costo (BLOQUEANTE — leer antes de codear)

La fórmula del usuario usa `line.total` (CON IVA). placepos usa `line.subtotal` (SIN IVA).

**Decisión recomendada de este spec (sujeta a confirmación del usuario, ver §4):** mantener `subtotal` (sin IVA) como base del costo, porque:
- El IVA de compra normalmente es crédito fiscal recuperable, no costo real del inventario.
- Cambiar a `total` altera retroactivamente TODOS los costos existentes de placepos.

**Si el usuario confirma `total`:** se cambia en UN solo punto por repo (`computePurchaseUnitMinCost`), idéntico en ambos, sustituyendo `line.subtotal` por `line.total`. El resto del algoritmo NO cambia.

> El resto de este spec asume el helper de flete y el helper de costo base reciben **la misma base** (`subtotal` o `total`), elegida una sola vez y compartida. El flete se suma DESPUÉS de la base, así que la elección de base no afecta el cálculo del flete (que depende solo de pesos y `transport_cost`).

---

## 1. ALGORITMO UNIFICADO (con Big.js)

Idéntico en placepos y pos_api. Toda operación con `Big`; nunca `Math.*` ni aritmética nativa sobre dinero.

### 1.1 Peso de línea (unidades mínimas)
```
peso(line):
  si line.packaging_value != null && Big(line.packaging_value) > 0:
      return Big(line.packaging_qty) * Big(line.packaging_value)
  si no:
      return Big(line.unit_qty)
```
Es exactamente `computeStockDelta` de placepos. Si el resultado es ≤ 0, la línea NO aporta ni a peso ni a flete.

### 1.2 Σ_peso de TODA la compra (una sola vez, antes de iterar por producto)
```
sigmaPeso = 0
para cada line de TODAS las líneas de la compra:
    u = peso(line)
    si u > 0: sigmaPeso += u
```
> Crítico: Σ_peso es sobre **todas** las líneas de la compra completa, NO por producto. Por eso se calcula antes del loop que agrupa por `product_id`.

### 1.3 Flete por unidad mínima (uniforme para toda la compra)
```
transportCost = Big(purchase.transport_cost ?? 0)

# CASO BORDE: sin flete o sin peso ⇒ no se distribuye nada
si transportCost <= 0  OR  sigmaPeso <= 0:
    fletePorUdMin = Big(0)
si no:
    fletePorUdMin = transportCost / sigmaPeso
```
`fletePorUdMin` se mantiene en precisión completa de Big (sin redondear) hasta el costo final.

### 1.4 Costo de compra por unidad mínima, por producto (con flete)
Agrupando las líneas por `product_id` (un producto puede tener varias líneas):
```
baseMin = computePurchaseUnitMinCost(productLines)   # Σ base / Σ unidades del producto
si baseMin == null: continue   # producto sin unidades válidas → no se costea

# El flete es uniforme por ud mínima, así que se suma directo:
purchaseUnitMinCost = baseMin + fletePorUdMin
```
- `computePurchaseUnitMinCost` = `(Σ line.subtotal) / (Σ peso(line))` del producto (o `line.total` si se confirma esa base). Devuelve `null` si `Σunidades<=0` o `Σbase<=0`.
- Equivalencia con la fórmula del usuario: como `fletePorUdMin` es constante para toda la compra, `Σ(base_linea)/Σ(peso) + flete` ≡ promedio ponderado de `(base_linea/peso_linea + flete)` por peso. Es matemáticamente lo mismo y evita división por línea.

### 1.5 Entrada al promedio ponderado (NO cambia respecto a placepos)
```
parentPkgValue = loadPackagingValue(product.packaging_id)   # Big(1) si no hay empaque o value<=0
costBefore     = Big(product.cost)
costBeforeMin  = costBefore / parentPkgValue
deltaUnits     = Σ peso(line) del producto   # sumStockDelta(productLines)

costNewMin = weightedAverageCost(stockBefore, costBeforeMin, deltaUnits, purchaseUnitMinCost)
#   si stockBefore<=0 OR costBeforeMin<=0: costNewMin = purchaseUnitMinCost
#   si no: (stockBefore*costBeforeMin + deltaUnits*purchaseUnitMinCost) / (stockBefore + deltaUnits)

costAfter = costNewMin * parentPkgValue        # de vuelta a unidad de empaque del padre
```
`stockBefore`:
- **RECEIVE:** `Big(product.stock)` directo (el recálculo corre ANTES del increment).
- **EDIT / ARCHIVE de compra RECEIVED:** override = stock previo al delta (Map por producto), porque el stock ya fue ajustado.

### 1.6 Persistencia y propagación (NO cambia)
- `Product.cost = round(costAfter, 2)` (numeric(15,2), HALF_UP). Si `round(costAfter,2) == round(costBefore,2)` → no-op (no log, no toca precios). Garantizar `cost >= 0` (CHECK).
- Insertar `product_cost_history`: `event_type`, `derived_from=PURCHASE`, `cost_before`, `cost_after` (round 4), `change_pct` (round 4; `null` si `cost_before==0`). En pos_api además `company_id`.
- Recalcular `ProductPrice.profit` / `ProductPrice.margin` contra el nuevo costo (**`sale_price` NO se toca**) e insertar `product_price_history` enlazado por `cost_history_id`. En pos_api además `company_id`.

### 1.7 Padre/Hijo
- El flete entra **solo** en `purchaseUnitMinCost` del producto comprado (la línea), por tanto solo afecta `parentCostMin` (`costNewMin`).
- Hijos (`parent_id = producto, archivados=false`): `child.cost = costNewMin * child.packaging.value`, `derived_from=PARENT`, **sin re-ponderar y sin re-prorratear flete** (ya viene incluido en `costNewMin`). Skips: `NO_PACKAGING` / `NO_PACKAGING_VALUE` / `ZERO_PACKAGING_VALUE`.

### 1.8 Resumen de casos borde
| Caso | Resolución |
|---|---|
| `transport_cost == 0` | `fletePorUdMin = 0` → costeo idéntico al actual |
| `Σ_peso == 0` | `fletePorUdMin = 0` (evita /0); el costo base ya da `null` y se omite el producto |
| Línea con `packaging_value` NULL/≤0 | usa `unit_qty` como peso; si `unit_qty<=0` no aporta a Σ_peso ni recibe flete |
| Padre/hijo | flete solo en padre; hijo hereda vía `costNewMin × child_pkg` |
| Redondeos | todo Big; cost→2 dec HALF_UP, history→4, change_pct→4; flete sin redondear hasta el final |
| `costBefore<=0` o `stockBefore<=0` | `costNewMin = purchaseUnitMinCost` (con flete incluido) |

---

## 2. placepos — cambio EXACTO (mínimo y fiel)

Archivo: `/Volumes/KiKe 1/development/placepos/src/main/database/purchaseReceiveOperations.ts`

### 2.1 Ampliar `RecalcOptions` (L193-202) — añadir flete
```ts
interface RecalcOptions {
    eventType: CostHistoryEvent
    purchaseId: number | null
    stockBeforeOverrides?: Map<number, Big>
    transportCost?: number          // NUEVO
}
```

### 2.2 `recalculateProductCosts` — calcular `fletePorUdMin` UNA vez (insertar entre L237 y L239)
```ts
const skipped: SkippedChild[] = []

// --- NUEVO: prorrateo de flete por unidad mínima (toda la compra) ---
const transportCost = new Big(options.transportCost ?? 0)
const sigmaPeso = lines.reduce((acc, l) => {
    const u = computeStockDelta(l as PurchaseLine)
    return u.gt(0) ? acc.plus(u) : acc
}, new Big(0))
const fletePorUdMin =
    transportCost.lte(0) || sigmaPeso.lte(0) ? new Big(0) : transportCost.div(sigmaPeso)
// --------------------------------------------------------------------

for (const [productId, productLines] of linesByProduct.entries()) {
    const baseMin = computePurchaseUnitMinCost(productLines)
    if (!baseMin) continue
    const purchaseUnitMinCost = baseMin.plus(fletePorUdMin)   // NUEVO: + flete
    ...
}
```
> Único cambio en el loop: renombrar `purchaseUnitMinCost = computePurchaseUnitMinCost(...)` (L240-241) a `baseMin` y sumar `fletePorUdMin`. NO se toca `weightedAverageCost`, `applyCostChange`, `propagateToChildren`, ni la conversión padre/hijo.

### 2.3 Pasar `transportCost` desde los 3 call-sites
- **RECEIVE** (`purchaseReceiveOperations.ts` L91-94): añadir `transportCost: Number(purchase.transport_cost)`.
- **EDIT** (`purchaseEditOperations.ts` L948-952): añadir `transportCost: newTransport.toNumber()`.
- **ARCHIVE / removidos** → ver §2.4.

### 2.4 `recalcCostFromLastActivePurchase` (L541-587) — flete de la compra de referencia
- Ampliar `findLastActivePurchaseLines` (L589-609) para traer también `p.transport_cost` de la última compra activa.
- Dentro de `recalcCostFromLastActivePurchase`, calcular su propio `sigmaPeso` + `fletePorUdMin` sobre ESAS líneas y sumarlo al costo base antes de ponderar.
- Esto cubre: **ARCHIVE** (la compra archivada deja de ser referencia; se toma el flete de la última activa) y **EDIT** de productos que pierden su línea.

> NOTA de base de costo: si se confirma `line.total`, cambiar L186 `new Big(line.subtotal)` → `new Big(line.total)` en `computePurchaseUnitMinCost`. Es el ÚNICO punto.

---

## 3. pos_api — archivos a CREAR / llamar (paridad)

### 3.1 Migraciones
**NINGUNA nueva.** `product_cost_history` (`1747009980000`) y `product_price_history` (`1747010040000`) ya existen. `Product.cost` (numeric(15,2)) basta para el promedio ponderado. NO se añade `avg_cost`.

### 3.2 Nuevo helper de costeo (CREAR)
Archivo: `/Volumes/KiKe 1/development/pos_api/src/modules/purchases/internal/recalculate-product-costs.helper.ts`

Port fiel de placepos + **dos adaptaciones obligatorias**: (a) `company_id` en TODO INSERT/lock/find; (b) prorrateo de flete (§1). Funciones:

1. `computeLineWeight(line): Big` — `packaging_qty * packaging_value`; degrada a `unit_qty` si `packaging_value` null/≤0.
2. `computeFreightPerUnitMin(lines, transportCost): Big` — §1.2/1.3 (guard `Σ_peso==0 || transport==0 → Big(0)`).
3. `computePurchaseUnitMinCost(productLines): Big | null` — `Σ base / Σ peso` (base = `subtotal` o `total` según decisión §0; **misma base que placepos**).
4. `weightedAverageCost({ stockBefore, costBefore, deltaUnits, costPurchase }): Big` — idéntico a placepos L315-324.
5. `recalculateProductCosts(manager, lines, options): Promise<{ skipped }>` — options: `{ eventType, purchaseId, companyId, transportCost, actor, stockBeforeOverrides? }`.
   - Calcula `freightPerUnitMin` una vez; por producto: lock `pessimistic_write` filtrando `company_id`, `costBeforeMin = cost / parentPkgValue`, pondera, `costAfter = costNewMin × parentPkgValue`, persiste `round(2)` HALF_UP, inserta cost-history (con `company_id`, `change_pct`), refresca `ProductPrice.profit/margin` (sale_price intacto) + price-history (con `company_id`, `cost_history_id`), propaga a hijos (`derived_from=PARENT`, sin re-ponderar) con skips.
6. `recalcCostFromLastActivePurchase(...)` — port + `company_id` en `findLastActivePurchaseLines`; reprorratea flete de la compra de referencia (§2.4).

> El helper recibe `manager: EntityManager` (NO inyección de repos). Reemplazar `getCurrentUser` de placepos por el `actor` (`actorId`/`actorName`) que ya viaja en cada action. Usar Big.js; respetar CHECK `cost >= 0`.

### 3.3 Puntos de llamada (cablear)

| Acción | Archivo | Dónde | Evento | stockBeforeOverrides |
|---|---|---|---|---|
| **Recepción** | `mark-purchase-received.action.ts` | entre L88 y L89, **ANTES** de `applyStockIncrements` | `RECEIVE` | No (stock aún previo) |
| **Edición de compra RECEIVED** | `update-purchase.action.ts` | tras INSERT de nuevas líneas (~L410) y junto a `applyInventoryDelta` (~L413); productos que pierden línea → `recalcCostFromLastActivePurchase` | `EDIT` | **Sí** (stock ya ajustado) |
| **Archivado de compra RECEIVED** | `archive-purchase.action.ts` | en/junto a `revertStock` (~L277) → `recalcCostFromLastActivePurchase` por producto | `ARCHIVE` | **Sí** |

Llamada en mark-received (ejemplo):
```ts
const recalc = await recalculateProductCosts(manager, purchaseLines, {
    eventType: 'RECEIVE',
    purchaseId: purchase.id,
    companyId: purchase.company_id,
    transportCost: Number(purchase.transport_cost),
    actor,
})
```
> Para EDIT/ARCHIVE: construir el `stockBeforeOverrides` Map (stock previo al delta por producto) igual que placepos `purchaseEditOperations.ts` L831-852, y recalcular `freightPerUnitMin` con el `transport_cost` NUEVO de la compra editada.

### 3.4 Concurrencia
`mark-purchase-received` usa transacción por defecto (READ COMMITTED). El helper lockea productos `pessimistic_write` ordenados por id ASC (anti-deadlock, igual que placepos). **Decisión abierta** (§4): subir a SERIALIZABLE por paridad con update/archive o conservar READ COMMITTED + lock pesimista.

---

## 4. Riesgos y decisiones abiertas (CONFIRMAR con el usuario)

1. **Base de costo: `total` (con IVA) vs `subtotal` (sin IVA).** La fórmula del usuario dice `total`; placepos usa `subtotal`. **Recomendación:** `subtotal` (IVA = crédito fiscal, no costo). Impacta valores históricos en placepos. **Debe confirmarse antes de codear** — es el único punto que diverge numéricamente.
2. **Flete al `Product.cost` en placepos.** Hoy placepos NO lo prorratea (flete vive solo en `CarrierCredit`). Esto cambia el costo de TODAS las compras futuras de placepos. Confirmar que el cambio aplica a ambos repos por la regla de paridad.
3. **EDIT de compra RECEIVED debe recalcular costo.** Implica re-prorrateo de flete con el nuevo `transport_cost` y `stockBeforeOverrides`. Confirmar que editar una compra recibida puede mover el costo (y por ende profit/margin) de productos.
4. **ARCHIVE de compra RECEIVED.** Al archivar, el costo se recalcula contra la última compra activa (con SU flete), no se "deshace" exactamente el promedio anterior. Confirmar esta semántica (es la de placepos).
5. **`sale_price` NO se recalcula** (solo profit/margin). Confirmar que es el comportamiento deseado (paridad placepos).
6. **Redondeo del costo a 2 decimales** HALF_UP, con no-op si no cambia. Confirmar tolerancia (history guarda 4 decimales).
7. **Nivel de aislamiento de mark-received** (READ COMMITTED vs SERIALIZABLE). Recomendación: conservar READ COMMITTED + lock pesimista ordenado (suficiente y ya implementado).
8. **CarrierCredit / flete duplicado:** verificar que prorratear flete al costo NO implique doble contabilización si el flete también genera un crédito al transportador. Confirmar que son conceptos independientes (costo de inventario vs cuenta por pagar).

---

## 5. Orden de implementación y verificación

### Orden recomendado
1. **placepos primero** (tiene la maquinaria; el cambio es quirúrgico):
   1. §2.1 ampliar `RecalcOptions`.
   2. §2.2 bloque `fletePorUdMin` + `.plus(fletePorUdMin)`.
   3. §2.3 pasar `transportCost` en RECEIVE y EDIT.
   4. §2.4 flete en `recalcCostFromLastActivePurchase` (+ `findLastActivePurchaseLines`).
   5. (Si se confirma `total`) cambiar base en `computePurchaseUnitMinCost`.
2. **pos_api** (port + multi-tenant + flete):
   1. §3.2 crear `recalculate-product-costs.helper.ts` (port fiel de placepos YA con flete).
   2. §3.3 cablear `mark-purchase-received` (RECEIVE).
   3. Cablear `update-purchase` (EDIT + removidos) y `archive-purchase` (ARCHIVE) con `stockBeforeOverrides`.
   4. Confirmar wiring de entities (`ProductCostHistory`, `ProductPriceHistory`, `ProductPrice`, `Packaging`) vía `manager`.

> Implementar 1.i→1.iv como una unidad; pos_api debe portar EXACTAMENTE el resultado final de placepos para garantizar paridad byte-a-byte de la fórmula.

### Verificación
- **Equivalencia matemática (caso flete=0):** con `transport_cost=0`, los costos resultantes deben ser idénticos a los del costeo actual de placepos. Test de regresión.
- **Caso 1 línea, 1 producto, stock previo 0:** `Product.cost = (subtotal/peso + transport/peso) × parentPkgValue`. Verificar a mano con Big.
- **Caso multi-línea / multi-producto:** verificar que `Σ_peso` es global (no por producto) y que cada producto recibe el mismo `fletePorUdMin`.
- **Promedio ponderado con stock previo:** producto con stock>0 y costo>0 → `(stockBefore·costBeforeMin + deltaUnits·(base+flete))/(stockBefore+deltaUnits)`.
- **Padre/hijo:** hijo = `costNewMin × child_pkg`; verificar que el flete está incluido y NO se re-prorratea.
- **Casos borde:** `Σ_peso=0`, `transport=0`, `packaging_value` NULL → sin /0, sin flete.
- **Historial:** confirmar filas en `product_cost_history` (`change_pct` null si `cost_before=0`) y `product_price_history` (`cost_history_id` enlazado). En pos_api: `company_id` presente y correcto (multi-tenant).
- **EDIT/ARCHIVE:** editar/archivar una compra recibida recalcula costo con `stockBeforeOverrides`; productos removidos caen a `recalcCostFromLastActivePurchase`.
- **Paridad placepos↔pos_api:** mismo input (misma compra/empaques/transport) ⇒ mismo `cost_after` en ambos repos. Test cruzado con valores fijos.
- **Concurrencia:** doble RECEIVE simultáneo → uno gana, el otro aborta; sin deadlock (lock por id ASC).
```