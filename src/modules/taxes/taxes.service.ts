import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TaxRate } from './entities/tax-rate.entity';

/**
 * Lectura del catálogo global de tarifas de IVA. Es de solo lectura desde la
 * app (las tarifas son nacionales y se siembran en migración), así que este
 * service solo lista. No hay scoping por company: el catálogo es compartido.
 */
@Injectable()
export class TaxesService {
  constructor(
    @InjectRepository(TaxRate)
    private readonly taxRatesRepo: Repository<TaxRate>,
  ) {}

  /** Tarifas activas, en orden de presentación. */
  findAllActive(): Promise<TaxRate[]> {
    return this.taxRatesRepo.find({
      where: { is_active: true },
      order: { sort_order: 'ASC', id: 'ASC' },
    });
  }
}
