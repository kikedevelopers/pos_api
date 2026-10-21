import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { TicketPrintConfigDto } from '../dto/ticket-print.dto';
import { getTicketPrintConfig } from '../internal/ticket-print-config';

/**
 * Lee la configuración de impresión del ticket (espacios para observaciones y
 * firma). Default false para ambos si las keys no existen.
 */
@Injectable()
export class GetTicketPrintAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<TicketPrintConfigDto> {
    return getTicketPrintConfig(this.dataSource.manager, companyId);
  }
}
