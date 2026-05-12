import { Injectable } from '@nestjs/common';

import { ArchivePackagingAction } from './actions/archive-packaging.action';
import { CreatePackagingAction, type PackagingCreator } from './actions/create-packaging.action';
import { FindAllPackagingsAction } from './actions/find-all-packagings.action';
import { UpdatePackagingAction } from './actions/update-packaging.action';
import type { CreatePackagingDto } from './dto/create-packaging.dto';
import type { UpdatePackagingDto } from './dto/update-packaging.dto';
import type { Packaging } from './entities/packaging.entity';

export type { PackagingCreator } from './actions/create-packaging.action';

/**
 * Facade delgado del dominio `packagings`. ZERO lógica de negocio — solo
 * delega a la action correspondiente. Patrón §3.1 del CLAUDE.md.
 *
 * Se exporta `TypeOrmModule` desde el módulo para que el módulo `products`
 * pueda hacer JOINs sobre `Packaging` sin reabrir `forFeature`.
 */
@Injectable()
export class PackagingsService {
  constructor(
    private readonly findAllPackagingsAction: FindAllPackagingsAction,
    private readonly createPackagingAction: CreatePackagingAction,
    private readonly updatePackagingAction: UpdatePackagingAction,
    private readonly archivePackagingAction: ArchivePackagingAction,
  ) {}

  findAll(companyId: number): Promise<Packaging[]> {
    return this.findAllPackagingsAction.execute(companyId);
  }

  create(
    dto: CreatePackagingDto,
    companyId: number,
    createdBy: PackagingCreator,
  ): Promise<Packaging> {
    return this.createPackagingAction.execute(dto, companyId, createdBy);
  }

  update(id: number, dto: UpdatePackagingDto, companyId: number): Promise<Packaging> {
    return this.updatePackagingAction.execute(id, dto, companyId);
  }

  archive(id: number, companyId: number): Promise<void> {
    return this.archivePackagingAction.execute(id, companyId);
  }
}
