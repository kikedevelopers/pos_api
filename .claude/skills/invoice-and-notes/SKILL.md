---
name: invoice-and-notes
description: Reglas de clasificación de tickets (ORDER vs SALE), notas de crédito/débito y tipos de operación (FULL_VOID, PARTIAL_VOID, ADDITION) y su impacto en stock, caja registradora y créditos. Cargar al tocar el módulo de ventas, anulaciones o reportes.
---

# Clasificación de facturas y notas

## Tipos de ticket (`TicketType`)

| Valor | Significado | Editable | Anulación |
|---|---|---|---|
| `ORDER` | Pedido / borrador. Sin pago confirmado. | Sí (PUT /sales/:id) | Soft delete directo (POST /sales/:id/void → marca `is_deleted=true`, sin nota). |
| `SALE` | Venta cerrada con pago (`CASH` / `TRANSFER` / `CREDIT`). | **No** | Vía `CreditNote` (POST /sales/:id/void genera nota `FULL_VOID`). |

Transición: `ORDER → SALE` cuando se confirma pago. **No** se revierte.

## Estados de `SaleInvoice`

Sin columna `status` explícita. El estado se infiere por:

- `is_deleted = false` + `ticket_type = ORDER` → pedido vigente
- `is_deleted = false` + `ticket_type = SALE` → venta vigente
- `is_deleted = true` → anulada
- + presencia de `CreditNote` con `operation_type = FULL_VOID` → anulación completa formalizada

## Notas (`CreditNote`)

La tabla `credit_notes` alberga **dos tipos lógicos**:

| `note_type` | Significado |
|---|---|
| `CREDIT` | **Reduce** el total de la venta original (devolución, descuento posterior, anulación). |
| `DEBIT` | **Aumenta** el total de la venta original (cargo extra, intereses por mora, ajuste al alza). |

## Tipos de operación (`operation_type`)

| Valor | Combina con | Significado | Impacto stock | Impacto dinero |
|---|---|---|---|---|
| `FULL_VOID` | `CREDIT` | Anula 100% de la venta. | Devuelve todas las líneas. | Reversa pagos (cash/transfer) o salda crédito. |
| `PARTIAL_VOID` | `CREDIT` | Anula líneas o cantidades específicas. | Devuelve solo lo anulado. | Reversa proporcional. |
| `ADDITION` | `DEBIT` | Añade cargos (intereses, recargo). | Cero. | Aumenta saldo a cobrar o registra ingreso adicional. |

**Combinaciones legales** (cualquier otra rechazar con `UnprocessableEntityException`):
- `note_type=CREDIT, operation_type=FULL_VOID` ✅
- `note_type=CREDIT, operation_type=PARTIAL_VOID` ✅
- `note_type=DEBIT, operation_type=ADDITION` ✅

## Impacto en stock (`Product.stock`)

- **FULL_VOID**: por cada línea original, `Product.stock += line.quantity`.
- **PARTIAL_VOID**: por cada línea de la nota, `Product.stock += note_line.quantity`.
- **ADDITION**: cero.

Implementación: dentro de la transacción, hacer `UPDATE products SET stock = stock + $qty WHERE id = $product_id AND company_id = $companyId`. Sin `findOne` + `++` + `save`.

## Impacto en caja / banco / crédito

### Si la venta era CASH

- `FULL_VOID`: `CashRegister.balance -= sale.total`. Log: `CashRegisterLog(movement_type=CREDIT_NOTE_FULL_VOID, direction=OUT, amount=sale.total)`.
- `PARTIAL_VOID`: idem proporcional con `movement_type=CREDIT_NOTE_PARTIAL_VOID`.

### Si la venta era TRANSFER

- Decrementa `Bank.balance` por el monto de la nota.
- Crea `FinancialMovement(movement_type=EXPENSE, concept=REFUND)` desde el banco.
- Genera `CorrectionSource(credit_note_id, source_type='bank', source_id=bank.id)` para registrar de dónde salió la devolución.

### Si la venta era CREDIT

- Ajusta `SaleCredit.balance` para reflejar la reducción del adeudo.
- Si la nota CREDIT cubre todo el saldo restante, `SaleCredit.status = PAID`.
- Si era DEBIT (ADDITION), aumenta `SaleCredit.balance` (o crea uno si era contado).

## Total consolidado de una venta

Una venta puede tener N notas (siempre 0 o 1 FULL_VOID, pero múltiples PARTIAL_VOID o ADDITION). El total consolidado:

```typescript
import { toBig, preciseNumber } from '@/common/utils/precision';

const credits = notes
  .filter(n => n.note_type === 'CREDIT')
  .reduce((acc, n) => acc.plus(toBig(n.total)), toBig(0));

const debits = notes
  .filter(n => n.note_type === 'DEBIT')
  .reduce((acc, n) => acc.plus(toBig(n.total)), toBig(0));

const consolidated = toBig(sale.total).minus(credits).plus(debits);
return preciseNumber(consolidated, 2);
```

Endpoints que lo exponen:
- `GET /sales/:id/consolidated` — consolidado completo.
- `GET /sales/:id/consolidated-upto/:noteId` — consolidado hasta una nota específica (para reimprimir tickets intermedios).

## Numeración de notas

Cada nota consume el `TicketSetting` correspondiente:

- `note_type=CREDIT` → `TicketSetting(company_id, ticket_type='CREDIT_NOTE')`.
- `note_type=DEBIT` → `TicketSetting(company_id, ticket_type='DEBIT_NOTE')`.

Formato: `${prefix}-${String(n).padStart(3, '0')}`. Ej: `NC-001`, `ND-001`.

Incremento atómico (ver skill `multi-tenant-rules`).

## Reglas de validación

1. **Una FULL_VOID por venta.** Si ya existe nota `operation_type=FULL_VOID` sobre la venta, rechazar nueva FULL_VOID con 409.
2. **PARTIAL_VOID**: la cantidad anulada por producto no puede superar `(quantity_original - Σ(quantity_ya_anulado))`. Si excede, 422.
3. **DEBIT sobre venta con `is_deleted=true`**: rechazar 422.
4. **CREDIT sobre venta inexistente, o `ticket_type=ORDER`, o `is_deleted=true`**: rechazar 404/422.
5. La nota hereda `company_id` y `customer_id` de la venta original. **No** del payload.
6. Toda operación de nota es transaccional: nota + líneas + stock + caja/banco/crédito + log + folio. Si algo falla, rollback completo.

## Flujo `POST /sales/:id/void` (FULL_VOID de SALE)

Pseudocódigo:

```typescript
await dataSource.transaction(async manager => {
  const sale = await loadSaleFullForUpdate(manager, id, companyId);
  if (!sale) throw new NotFoundException();
  if (sale.is_deleted) throw new ConflictException('Venta ya anulada');
  if (sale.ticket_type === 'ORDER') return voidOrderDirect(manager, sale);

  await assertNoExistingFullVoid(manager, sale.id);

  const noteNumber = await incrementTicketCounter(manager, companyId, 'CREDIT_NOTE');
  const note = await manager.save(CreditNote, {
    company_id: companyId,
    note_number: noteNumber,
    note_type: 'CREDIT',
    operation_type: 'FULL_VOID',
    original_invoice_id: sale.id,
    total: sale.total,
    created_by: user.full_name,
    created_by_id: user.id,
  });

  await manager.save(CreditNoteLine, sale.lines.map(l => ({
    company_id: companyId,
    credit_note_id: note.id,
    item_id: l.item_id,
    name: l.name,
    cost: l.cost,
    price: l.price,
    quantity: l.quantity,
    total: l.total,
  })));

  for (const l of sale.lines) {
    await manager.increment(Product, { id: l.item_id, company_id: companyId }, 'stock', l.quantity);
  }

  await applyMoneyReversal(manager, sale, note, companyId);

  await manager.update(SaleInvoice, { id: sale.id, company_id: companyId }, { is_deleted: true });

  return note;
});
```

## Lo que SÍ va al cliente PlacePos

El cliente PlacePos espera:
- `GET /sales/:id` devuelve la venta con sus líneas, pagos, crédito (si aplica) y notas existentes.
- `GET /sales/:id/consolidated` devuelve la venta con totales recalculados.
- `GET /sales/:id/credit-note` devuelve la nota FULL_VOID si existe (404 si no).

Forma exacta de los objetos: ver `placepos/src/main/database/saleOperations.ts:117` (`getTicketById`).
