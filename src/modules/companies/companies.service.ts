import { Injectable } from '@nestjs/common';

import { ProductImagesService } from '@/modules/product-images/product-images.service';

import { CheckCatalogSlugAction, type SlugAvailability } from './actions/check-catalog-slug.action';
import { GetCurrentCompanyAction } from './actions/get-current-company.action';
import {
  ListAllCompaniesAction,
  type ListAllCompaniesResult,
} from './actions/list-all-companies.action';
import {
  RemoveCatalogCoverAction,
} from './actions/remove-catalog-cover.action';
import { UpdateCatalogSettingsAction } from './actions/update-catalog-settings.action';
import {
  UploadCatalogCoverAction,
  type UploadedCatalogCover,
} from './actions/upload-catalog-cover.action';
import { UpdateCompanyAction } from './actions/update-company.action';
import type { UploadedImageFile } from '@/modules/product-images/internal/image-file';
import type { ListCompaniesQueryDto } from './dto/list-companies-query.dto';
import type { UpdateCatalogSettingsDto } from './dto/update-catalog-settings.dto';
import type { UpdateCompanyDto } from './dto/update-company.dto';
import type { Company } from './entities/company.entity';

export type { ListAllCompaniesResult } from './actions/list-all-companies.action';

/**
 * Facade del módulo `companies`. ZERO lógica — solo delega a las actions.
 */
@Injectable()
export class CompaniesService {
  constructor(
    private readonly getCurrentCompanyAction: GetCurrentCompanyAction,
    private readonly updateCompanyAction: UpdateCompanyAction,
    private readonly listAllCompaniesAction: ListAllCompaniesAction,
    private readonly updateCatalogSettingsAction: UpdateCatalogSettingsAction,
    private readonly checkCatalogSlugAction: CheckCatalogSlugAction,
    private readonly uploadCatalogCoverAction: UploadCatalogCoverAction,
    private readonly removeCatalogCoverAction: RemoveCatalogCoverAction,
    private readonly productImages: ProductImagesService,
  ) {}

  getCurrent(companyId: number): Promise<Company> {
    return this.getCurrentCompanyAction.execute(companyId);
  }

  update(companyId: number, dto: UpdateCompanyDto): Promise<Company> {
    return this.updateCompanyAction.execute(companyId, dto);
  }

  listAll(query: ListCompaniesQueryDto): Promise<ListAllCompaniesResult> {
    return this.listAllCompaniesAction.execute(query);
  }

  updateCatalogSettings(companyId: number, dto: UpdateCatalogSettingsDto): Promise<Company> {
    return this.updateCatalogSettingsAction.execute(companyId, dto);
  }

  checkCatalogSlug(companyId: number, slug: string): Promise<SlugAvailability> {
    return this.checkCatalogSlugAction.execute(companyId, slug);
  }

  uploadCatalogCover(params: {
    companyId: number;
    file: UploadedImageFile | undefined;
    actor: { id: number; fullName: string };
  }): Promise<UploadedCatalogCover> {
    return this.uploadCatalogCoverAction.execute(params);
  }

  removeCatalogCover(companyId: number): Promise<Company> {
    return this.removeCatalogCoverAction.execute(companyId);
  }

  /** URL-proxy firmada (relativa) de la portada del catálogo, o null. */
  resolveCatalogCoverUrl(company: Company): Promise<string | null> {
    return this.productImages.resolveOne(company.catalog_cover_image, Number(company.id));
  }
}
