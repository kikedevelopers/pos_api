import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Employee } from '@/modules/employees/entities/employee.entity';

import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';
import { findSaleInCompany } from '../internal/sale-lookups';

/** Resultado mínimo que el controller envuelve en `{ success, payload }`. */
export interface AssignOrderActionResult {
  id: number;
  assignedToUserId: number | null;
  assignedToName: string | null;
  /** Asignado ANTES de esta operación (para notificar en vivo a quien "sale"). */
  previousAssignedToUserId: number | null;
}

/**
 * Comparte un PEDIDO (ticket_type=ORDER) con otro empleado para que lo aliste
 * —feature RETAIL "Compartir pedido para alistar"— o quita la asignación.
 *
 * Reglas (todas revalidadas en el backend; la UI solo las refleja):
 *   - Solo pedidos: `ticket_type = ORDER`. Un pedido ya cobrado (ORDER→SALE) o
 *     un préstamo (LOAN) NO se puede (re)asignar ni desasignar → 409. Así la
 *     asignación queda CONGELADA al cobrar: "una vez cobrado, no se cambia ni se
 *     cancela".
 *   - No anulado (`is_deleted = false`): se exige con `requireActive`.
 *   - El asignado debe ser un empleado de la company con ACCESO al sistema
 *     (login activo, no archivado) y vinculado a un User (`user_id`) → 422 si no.
 *   - No se asigna al CREADOR del pedido (no tiene sentido asignárselo a sí
 *     mismo; además rompería la regla "no suma a sus totales") → 422.
 *
 * La asignación amplía la VISIBILIDAD del asignado (lo ve en su feed), pero NO
 * toca la atribución (`created_by_id`), de modo que los informes de totales
 * nunca lo doble-cuentan.
 *
 * Transacción con lock pesimista sobre el pedido (evita carreras de doble
 * asignación/cobro simultáneo).
 */
@Injectable()
export class AssignOrderAction {
  private readonly logger = new Logger(AssignOrderAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(params: {
    invoiceId: number;
    companyId: number;
    assignedToUserId: number | null;
  }): Promise<AssignOrderActionResult> {
    const { invoiceId, companyId, assignedToUserId } = params;

    return this.dataSource.transaction<AssignOrderActionResult>(async (manager) => {
      // Lock del pedido: localiza dentro de la company y exige NO anulado.
      const sale = await findSaleInCompany(manager, invoiceId, companyId, {
        requireActive: true,
        lock: true,
      });

      const previousAssignedToUserId =
        sale.assigned_to_user_id !== null ? Number(sale.assigned_to_user_id) : null;

      if (sale.ticket_type !== TicketType.ORDER) {
        throw new ConflictException(
          sale.ticket_type === TicketType.SALE
            ? 'El pedido ya fue cobrado: su asignación quedó bloqueada y no se puede cambiar.'
            : 'Solo se puede compartir un pedido (ORDER).',
        );
      }

      // Desasignar.
      if (assignedToUserId === null) {
        await manager.update(
          SaleInvoice,
          { id: sale.id, company_id: String(companyId) },
          { assigned_to_user_id: null, assigned_to_name: null },
        );
        this.logger.log({
          event: 'sale.order.unassigned',
          companyId,
          saleId: Number(sale.id),
        });
        return {
          id: Number(sale.id),
          assignedToUserId: null,
          assignedToName: null,
          previousAssignedToUserId,
        };
      }

      // No asignar al propio creador del pedido.
      if (sale.created_by_id !== null && sale.created_by_id === String(assignedToUserId)) {
        throw new UnprocessableEntityException(
          'No puedes compartir el pedido con quien lo creó.',
        );
      }

      // El asignado debe ser un empleado de la company con acceso al sistema.
      const employee = await manager.findOne(Employee, {
        where: {
          company_id: String(companyId),
          user_id: String(assignedToUserId),
          login_enabled: true,
          is_archived: false,
        },
        select: { id: true, name: true, user_id: true },
      });

      if (!employee) {
        throw new UnprocessableEntityException(
          'El empleado seleccionado no existe o no tiene acceso al sistema.',
        );
      }

      await manager.update(
        SaleInvoice,
        { id: sale.id, company_id: String(companyId) },
        { assigned_to_user_id: String(assignedToUserId), assigned_to_name: employee.name },
      );

      this.logger.log({
        event: 'sale.order.assigned',
        companyId,
        saleId: Number(sale.id),
        assignedToUserId,
      });

      return {
        id: Number(sale.id),
        assignedToUserId,
        assignedToName: employee.name,
        previousAssignedToUserId,
      };
    });
  }
}
