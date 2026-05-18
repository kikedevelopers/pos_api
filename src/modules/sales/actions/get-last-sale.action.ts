import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SaleInvoice } from '../entities/sale-invoice.entity';

/**
 * Resultado mínimo del endpoint GET /sales/last — espejo PlacePos
 * `getLastTicketByUser`: solo id + ticketNumber.
 */
export interface LastSaleResult {
  id: number;
  ticketNumber: string;
}

@Injectable()
export class GetLastSaleAction {
  constructor(
    @InjectRepository(SaleInvoice)
    private readonly salesRepo: Repository<SaleInvoice>,
  ) {}

  async execute(companyId: number): Promise<LastSaleResult | null> {
    const row = await this.salesRepo.findOne({
      where: { company_id: String(companyId) },
      order: { created_at: 'DESC' },
      select: { id: true, ticket_number: true },
    });
    if (!row) {
      return null;
    }
    return { id: Number(row.id), ticketNumber: row.ticket_number };
  }
}
