<!--
  ARCHIVO COMPARTIDO / BYTE-IDÉNTICO ENTRE REPOS.
  Copia espejo en:
    - pos_api  : src/modules/financial-facts/contracts/metrics-spec.md
    - placepos : src/main/financial/contracts/metrics-spec.md
  Si editas uno, edita el otro EN LA MISMA TAREA. El test de paridad
  (Fase 3) diffea ambos y falla si divergen.
-->

# Contrato canónico de métricas financieras del POS

Fuente única de la verdad para las métricas del día/rango. Toda vista
(cierre, resumen extendido, dashboard "hoy", por cajero, rendimiento,
impacto de gastos, meta/break-even, comparativa) DEBE derivar sus números
de estas definiciones. **Una implementación por concepto**; los conceptos
distintos NO se colapsan, pero cada uno tiene una sola query/función.

## 0. Por qué existía divergencia (dos ejes que se mezclaban sin nombrarse)

1. **Base temporal** — *devengado* vs *caja*:
   - *Devengado (accrual)*: se reconoce el día en que la venta se REALIZA,
     por `COALESCE(si.sold_at, si.created_at)`, usando la columna
     autoritativa `sale_invoices.profit` / `.cost` / `.total`.
   - *Caja*: se reconoce el día en que ENTRA el dinero, por
     `sale_payments.created_at`.
2. **Modelo de utilidad de abonos a crédito** — *cascada cost-first* vs
   *share proporcional*. Deben converger a UNO (ver §2).

Cada endpoint había elegido una combinación distinta y luego se copió. La
solución no es un número único, es **nombrar cada concepto y tener una sola
implementación por concepto**, más un ensamblado explícito por endpoint.

## 1. Decisión canónica de "Ganancia del día" (headline): COBRADA (base caja)

La **"Ganancia del día"** que se muestra como headline en Dashboard, cierre,
resumen extendido y meta es **`collectedProfit`** (base caja / cobrado):

- Se reconoce cuando **entra el dinero** (`sp.created_at`), igual que el recaudo.
- Es la **porción de utilidad dentro del recaudo**: cada pago no anulado cobra
  `LEAST(pago, total) · (total − cost) / total` (consolidado neto de notas). Un
  contado pagado al 100% cobra su utilidad completa; un abono, la parte
  proporcional.
- **Una venta a crédito NO suma su ganancia hasta que se cobra.** La utilidad
  aún no cobrada no entra (no está en la caja).
- Consecuencia clave (por diseño del negocio): la ganancia es **fiel a la caja**
  y consistente con el recaudo. Si hoy hubiera que liquidar obligaciones
  (arriendo, nómina), la ganancia mostrada corresponde a plata realmente
  disponible, no a cuentas por cobrar.

Razones: (a) el negocio es de base caja — gastos fijos se pagan con dinero real;
(b) la "Meta del mes" es un objetivo de punto de equilibrio/liquidez, que solo
tiene sentido contra lo cobrado; (c) recaudo y ganancia quedan en la MISMA base
temporal (fecha de pago), eliminando el descuadre del modelo viejo (recaudo por
pago, ganancia por venta); (d) coincide al peso con el comportamiento de
producción para datos reales.

`realizedProfit` (utilidad DEVENGADA, reconocida al vender por la columna
`si.profit`) queda disponible como métrica alterna (`sales-facts.ts`) para un
eventual reporte de utilidad devengada, pero NO es el headline.

## 2. Tabla de métricas canónicas

| Métrica | Semántica | Base temporal / grano | Fórmula |
|---|---|---|---|
| **`collectedProfit`** (headline "Ganancia del día") | Utilidad COBRADA: porción de utilidad dentro del recaudo (contado + abonos) | caja `sp.created_at` / pago | `SUM(LEAST(pago, total) · (total − cost) / total)` consolidado neto de notas, todos los pagos no anulados |
| `recaudo` (`collectedRevenue`) | Dinero efectivamente recibido | caja `sp.created_at` / pago | `SUM(LEAST(sp.amount, si.total))` contado+consig + `SUM(sp.amount)` abonos |
| `realizedProfit` (utilidad DEVENGADA — métrica ALTERNA, no headline) | Utilidad reconocida al vender, incluye crédito | devengado `COALESCE(sold_at,created_at)` / factura | `SUM(si.profit)` de TODAS las SALE del rango + ajuste de notas |
| `realizedSalesRevenue` | Ingreso de ventas de contado+consignación realizadas | devengado / factura | net cash (gross − NC + ND) + consignación, por método; excluye facturas con crédito |
| `salesByMethod` | Contado / consignación / crédito | según métrica base / pago | ramas `CASH` / `TRANSFER` / crédito |
| `expensesVariable` (gastos) | Solo gastos variables no archivados | `expenses.created_at` / gasto | `SUM(amount) WHERE is_fixed=false AND is_archived=false` (fijos y carrier_payments EXCLUIDOS) |
| `newCredits` | Ventas a crédito generadas | devengado / crédito | `sale_credits` ⨝ factura SALE realizada en rango |
| `abonos` | Cobros a créditos | caja `sp.created_at` / pago | `SUM(sp.amount)` con `EXISTS sale_credits`, `is_voided=false` |
| `cartera` (`pendingCredits`) | Saldo por cobrar vivo | **point-in-time (sin rango)** / crédito | `SUM(balance) WHERE balance>0` ⨝ SALE no anulada |
| `realProfit` (utilidad neta) | Utilidad tras gastos | derivada | `collectedProfit − expensesVariable` |
| `surplus` (excedente/reinversión) | COGS cobrado a reinvertir | derivada de caja | `collectedRevenue − collectedProfit` |
| `goal` / `cuota` | Meta break-even y cuota diaria | mes | `dailyQuota = goal / díasPeriodo`; `progress = realProfitAcum / goal` (redondeo a 4 decimales) |

### Modelo único de utilidad de abonos (para `collectedProfit`): PROPORCIONAL

Cada abono aporta utilidad proporcional a su monto: `effective · profit/total`
(con `effective = LEAST(abono, saldo_consolidado)`), preservando la identidad
`recaudo = costo + ganancia`. Es el modelo que ya usaba `/dashboard/performance`.
Sustituye al modelo "cascada cost-first" del cierre. El contado se trata igual
(pago proporcional), de modo que `collectedProfit = salesProfit (contado) +
creditsProfit (abonos)` — la "Ganancia del día" es la suma de los dos bloques
del cierre.

## 3. Rótulos (front)

- **"Ganancia" / "Ganancia del día"** = `collectedProfit` (utilidad cobrada).
- **"Ganancia real" / "Utilidad neta"** = `realProfit` (= cobrada − gastos).
- **"Excedente" / "Reinversión"** = `surplus` (= COGS cobrado) = `recaudo −
  collectedProfit`.

## 4. Convenciones invariables

- **Big.js**: todo cálculo/redondeo monetario pasa por `toBig`/`preciseNumber`
  (`common/utils/precision.ts`); redondear solo al exponer. Progreso de meta a
  4 decimales (no 2) para no falsear 99.75% → 100%.
- **Multi-tenant**: `company_id = $1` en CADA tabla de CADA JOIN/subquery
  (aplica a pos_api; en placepos offline hay un solo tenant por instancia).
- **Zona horaria**: `America/Bogota`. Ventas por `COALESCE(sold_at, created_at)`;
  recaudo por `sp.created_at`; límites del día en hora Colombia (nunca UTC).
- **Pagos anulados**: `sp.is_voided = false` en TODA lectura de `sale_payments`.
- **SELECT puro**: sin transacción (solo lectura).

## 5. Diferencias de esquema entre repos (encapsuladas en el SQL)

El contrato (nombres de métrica, fórmulas, `profit-model`) es idéntico; solo
cambian los nombres físicos de columna dentro de los strings SQL:

| Concepto | pos_api | placepos |
|---|---|---|
| FK pago→factura | `sale_payments.sale_invoice_id` | `sale_payments.invoice_id` |
| Monto del pago | `sale_payments.amount` | `sale_payments.amount_paid` |
| FK crédito→factura | `sale_credits.sale_invoice_id` | `sale_credits.invoice_id` |
| FK nota→factura | `credit_notes.sale_invoice_id` | `credit_notes.original_invoice_id` |
| Costo de línea de nota | `credit_note_lines.unit_cost` | `credit_note_lines.cost` |

## 6. Regla de paridad

Cualquier cambio de fórmula o semántica se replica en pos_api y placepos EN LA
MISMA TAREA, y se verifica con las golden fixtures compartidas
(`financial-golden-fixtures.json`), que ambas suites de tests cargan y afirman.
