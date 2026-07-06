import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Customer } from '@/modules/customers/entities/customer.entity';

/**
 * Helpers de CONSUMO / RESTAURACIÓN del anticipo del cliente
 * (`customers.advance_balance`) como medio de pago.
 *
 * Espejo de `placepos/src/main/database/customerAdvanceOperations.ts`
 * (`consumeCustomerAdvance` / `restoreCustomerAdvance`) adaptado a la
 * arquitectura multi-tenant de pos_api:
 *
 *   - Ambos helpers reciben el `EntityManager` de la transacción en curso, para
 *     que la mutación de `advance_balance` sea atómica con el resto del cobro /
 *     anulación / reverso.
 *   - Ambos bloquean el row del `customer` con `pessimistic_write` respetando el
 *     filtro `company_id` (aislamiento cross-tenant, como el resto del módulo).
 *   - Todo cálculo con Big.js (`toBig`/`preciseNumber`), nunca `number` directo.
 *   - NINGUNO mueve caja/banco: el dinero del anticipo ya ingresó al crearlo
 *     (concepto CUSTOMER_ADVANCE). Consumirlo o restaurarlo aquí volvería a
 *     moverlo y lo contaría doble.
 */

/**
 * El anticipo del cliente no alcanza a cubrir el monto solicitado al cobrar. El
 * `code` `ADVANCE_EXCEEDS_BALANCE` permite al `ProcessPaymentAction` mapearlo a
 * un result `{ success:false, code }` (422) con el mismo shape que PlacePos —
 * el frontend ramifica sin diff entre modo local y cloud.
 */
export class InsufficientAdvanceError extends Error {
  public readonly code = 'ADVANCE_EXCEEDS_BALANCE';

  constructor(message: string) {
    super(message);
    this.name = 'InsufficientAdvanceError';
  }
}

/**
 * Bloquea el `customer` (multi-tenant) para serializar mutaciones concurrentes
 * de `advance_balance`. Lanza `NotFoundException` si no existe o pertenece a
 * otra company (anti-enumeración cross-tenant).
 */
async function lockCustomerForAdvance(
  manager: EntityManager,
  customerId: number,
  companyId: number,
): Promise<Customer> {
  const customer = await manager.findOne(Customer, {
    where: { id: String(customerId), company_id: String(companyId) },
    lock: { mode: 'pessimistic_write' },
  });
  if (!customer) {
    throw new NotFoundException('Cliente no encontrado');
  }
  return customer;
}

/**
 * CONSUMO del anticipo como medio de pago al cobrar una venta. Bloquea el
 * cliente, valida `amount > 0` y `amount <= advance_balance`, y descuenta
 * `advance_balance` con Big.js. NO mueve caja/banco.
 *
 * Si el anticipo no alcanza (o `amount <= 0`) lanza `InsufficientAdvanceError`
 * (code `ADVANCE_EXCEEDS_BALANCE`), que el `ProcessPaymentAction` mapea a 422.
 * Debe correr DENTRO de la transacción del cobro para ser atómico.
 */
export async function consumeCustomerAdvance(
  manager: EntityManager,
  customerId: number,
  companyId: number,
  amount: number,
): Promise<void> {
  const consume = toBig(amount);
  if (consume.lte(0)) {
    throw new InsufficientAdvanceError('El monto de anticipo debe ser mayor a cero');
  }
  const customer = await lockCustomerForAdvance(manager, customerId, companyId);
  const current = toBig(customer.advance_balance);
  if (consume.gt(current)) {
    throw new InsufficientAdvanceError(
      `El anticipo del cliente es insuficiente. Disponible: $${preciseNumber(
        current,
        2,
      ).toLocaleString('es-CO')}.`,
    );
  }
  const newBalance = preciseNumber(current.minus(consume), 2);
  await manager.update(
    Customer,
    { id: String(customerId), company_id: String(companyId) },
    { advance_balance: newBalance },
  );
}

/**
 * RESTAURA (devuelve) saldo de anticipo al cliente cuando se anula la venta o
 * se reversa un pago tipo ADVANCE. Inverso de `consumeCustomerAdvance`: vuelve a
 * acumular en `advance_balance` sin mover caja (el dinero nunca salió de caja al
 * consumir el anticipo, así que restaurarlo tampoco la toca). No-op si
 * `amount <= 0`. Debe correr DENTRO de la transacción de anulación/reverso.
 */
export async function restoreCustomerAdvance(
  manager: EntityManager,
  customerId: number,
  companyId: number,
  amount: number,
): Promise<void> {
  const restore = toBig(amount);
  if (restore.lte(0)) {
    return;
  }
  const customer = await lockCustomerForAdvance(manager, customerId, companyId);
  const newBalance = preciseNumber(toBig(customer.advance_balance).plus(restore), 2);
  await manager.update(
    Customer,
    { id: String(customerId), company_id: String(companyId) },
    { advance_balance: newBalance },
  );
}
