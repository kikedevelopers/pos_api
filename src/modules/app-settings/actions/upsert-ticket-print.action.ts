import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { TicketPrintConfigDto, UpdateTicketPrintDto } from '../dto/ticket-print.dto';
import {
  getTicketPrintConfig,
  setTicketPrintConfig,
  type TicketPrintConfigPatch,
} from '../internal/ticket-print-config';

/**
 * Set PARCIAL de la configuración de impresión del ticket. El guard de admin
 * (`canAccessSettings`) vive en el controller y la forma de cada campo la
 * valida el DTO. Persiste solo los campos enviados y devuelve la configuración
 * COMPLETA resultante (leída dentro de la misma transacción).
 */
@Injectable()
export class UpsertTicketPrintAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(dto: UpdateTicketPrintDto, companyId: number): Promise<TicketPrintConfigDto> {
    const patch: TicketPrintConfigPatch = {
      ...(typeof dto.observations_enabled === 'boolean'
        ? { observations_enabled: dto.observations_enabled }
        : {}),
      ...(Array.isArray(dto.observations_ticket_types)
        ? { observations_ticket_types: dto.observations_ticket_types }
        : {}),
      ...(typeof dto.signature_enabled === 'boolean'
        ? { signature_enabled: dto.signature_enabled }
        : {}),
      ...(Array.isArray(dto.signature_ticket_types)
        ? { signature_ticket_types: dto.signature_ticket_types }
        : {}),
    };
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException(
        'Debe enviarse al menos uno de: observations_enabled, observations_ticket_types, signature_enabled, signature_ticket_types',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      await setTicketPrintConfig(manager, companyId, patch);
      return getTicketPrintConfig(manager, companyId);
    });
  }
}
