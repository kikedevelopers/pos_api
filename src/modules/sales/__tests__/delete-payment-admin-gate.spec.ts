import { GUARDS_METADATA } from '@nestjs/common/constants';

import { AdminLevelGuard } from '@/common/guards/admin-level.guard';

import { SalesController } from '../sales.controller';

/**
 * Reversar un pago o abono saca dinero de una caja/banco: solo NIVEL ADMIN
 * (owner/superadmin o empleado con el rol Administrador). Antes el endpoint
 * aceptaba a cualquier empleado. El comportamiento del guard (todas las keys
 * del catálogo) está cubierto en `admin-level.guard.spec.ts`.
 */
const guardsOf = (method: keyof SalesController): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, SalesController.prototype[method]) as unknown[]) ?? [];

describe('SalesController — gate de admin del reverso de pagos', () => {
  it('DELETE /sales/:saleId/payments/:paymentId exige AdminLevelGuard', () => {
    expect(guardsOf('deletePayment')).toContain(AdminLevelGuard);
  });

  it.each(['update', 'findConsolidated'] as const)(
    '%s NO exige nivel admin (el POS lo usa cualquier empleado)',
    (method) => {
      expect(guardsOf(method)).not.toContain(AdminLevelGuard);
    },
  );
});
