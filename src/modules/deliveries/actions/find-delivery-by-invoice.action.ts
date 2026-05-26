import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Delivery } from '../entities/delivery.entity';

/**
 * Action de `GET /deliveries/by-invoice/:invoiceId`. Devuelve el domicilio NO
 * archivado MÁS RECIENTE (orden por `created_at DESC`) ligado a una venta
 * dentro del tenant, o `null` si no existe.
 *
 * A diferencia de `FindDeliveryAction`, aquí `null` es un resultado válido (el
 * modal de ticket simplemente no muestra info de domicilio); NO se lanza 404.
 *
 * **Multi-tenancy**: el filtro `company_id` (tenant) SIEMPRE se aplica junto
 * con `invoice_id`. `invoice_id` es `bigint` en la entidad, por lo que se
 * compara como string para evitar pérdida de precisión.
 *
 * **Performance**: cubierto por el índice
 * `(company_id, created_at DESC) WHERE is_archived = false`; el filtro extra
 * por `invoice_id` reduce aún más el conjunto.
 */
@Injectable()
export class FindDeliveryByInvoiceAction {
  constructor(
    @InjectRepository(Delivery)
    private readonly repo: Repository<Delivery>,
  ) {}

  execute(invoiceId: number, companyId: number): Promise<Delivery | null> {
    return this.repo.findOne({
      where: {
        invoice_id: String(invoiceId),
        company_id: String(companyId),
        is_archived: false,
      },
      // Más reciente primero; desempate por id para determinismo.
      order: { created_at: 'DESC', id: 'DESC' },
    });
  }
}
