import { Injectable } from '@nestjs/common';

import { FindActiveOrdersAction } from './actions/find-active-orders.action';
import type { ComandaDto } from './dto/comanda.dto';

/** Facade delgado del dominio `comandas`. Solo delega a las actions. */
@Injectable()
export class ComandasService {
  constructor(private readonly findActiveOrdersAction: FindActiveOrdersAction) {}

  findActive(companyId: number): Promise<ComandaDto[]> {
    return this.findActiveOrdersAction.execute(companyId);
  }
}
