import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SaleInvoice } from '../entities/sale-invoice.entity';

/**
 * Gate fail-closed del "asignado-informativo": el empleado al que se le COMPARTIÓ
 * un pedido para alistarlo solo puede VER/IMPRIMIR ese pedido. No puede cobrarlo,
 * abonarlo, editarlo, anularlo, reversar pagos ni reasignarlo.
 *
 * "Asignado-informativo" = `assigned_to_user_id` es el actor Y `created_by_id` NO
 * es el actor: el pedido no es suyo, solo lo prepara. Mismo criterio que el
 * `isAssignedToMe` del feed (ver `find-all-sales.action.ts`) y que el visor de
 * PlacePos, que oculta todas las acciones salvo Imprimir.
 *
 * No-op para el creador, para quien no es el asignado y para quien ve un pedido
 * sin asignación. Un owner/admin no cae aquí salvo que el pedido le esté asignado
 * (que no ocurre: la asignación excluye al creador y apunta a empleados).
 *
 * Se invoca en los controllers de las operaciones mutantes ANTES de ejecutarlas.
 * Si el pedido no existe, es no-op: deja que la operación real devuelva su 404.
 */
@Injectable()
export class AssertNotAssignedViewerAction {
  constructor(
    @InjectRepository(SaleInvoice)
    private readonly salesRepo: Repository<SaleInvoice>,
  ) {}

  async execute(params: {
    saleId: number;
    companyId: number;
    actorUserId: number | null | undefined;
  }): Promise<void> {
    const { saleId, companyId, actorUserId } = params;
    // Sin actor identificable (p. ej. cuenta owner sin users.id) no aplica: el
    // gate de rol correspondiente ya cubre esos casos.
    if (actorUserId == null) return;

    const sale = await this.salesRepo.findOne({
      where: { id: String(saleId), company_id: String(companyId) },
      select: { id: true, assigned_to_user_id: true, created_by_id: true },
    });
    if (!sale) return;

    const actor = String(actorUserId);
    const isAssignedViewer =
      sale.assigned_to_user_id !== null &&
      sale.assigned_to_user_id === actor &&
      sale.created_by_id !== actor;

    if (isAssignedViewer) {
      throw new ForbiddenException({
        message:
          'Este pedido te fue asignado solo para alistarlo: no puedes cobrarlo, ' +
          'abonarlo, editarlo, anularlo ni compartirlo. Solo puedes imprimirlo.',
        payload: { code: 'ASSIGNED_VIEWER_READONLY' },
      });
    }
  }
}
