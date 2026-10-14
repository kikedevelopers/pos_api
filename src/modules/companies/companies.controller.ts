import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { resolveMaxCoverImageSizeBytes } from '@/config/product-images.config';

import type { SlugAvailability } from './actions/check-catalog-slug.action';
import { CompaniesService } from './companies.service';
import { CompanyResponseDto, toCompanyResponseDto } from './dto/company-response.dto';
import { UpdateCatalogSettingsDto } from './dto/update-catalog-settings.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

/**
 * Endpoints de `/companies`. Espejo del contrato PlacePos
 * (`companies.routes.ts`):
 *
 *   - `GET    /companies`         → company autenticada (la del JWT).
 *   - `PUT    /companies/:id`     → actualiza la company autenticada.
 *
 * Roles:
 *   - `GET`: cualquier rol autenticado (owner / manager / employee). El POS
 *     necesita la info del negocio en operación normal (impresión de
 *     tickets, header del UI).
 *   - `PUT`: `owner`/`manager` por tipo, o `employee` con la key
 *     `canAccessSettings` (rol Administrador). Editar el perfil del negocio
 *     es parte de Configuraciones → Mi Negocio; el empleado con rol
 *     Administrador accede igual que el dueño (paridad con PlacePos, cuyo
 *     `PUT /companies/:id` no exige rol de dueño).
 *
 * Multi-tenancy: `@CurrentCompany()` propaga el `company_id` del JWT al
 * service. En `PUT`, el path param `:companyId` se valida contra el JWT
 * (defensa anti-IDOR explícita) — el contrato preserva el id en la URL
 * por paridad con PlacePos.
 */
@ApiTags('companies')
@ApiBearerAuth('bearer')
@Controller('companies')
export class CompaniesController {
  /** Techo multer de la portada: el tope real + holgura. */
  private static readonly MULTER_COVER_CEILING_BYTES = resolveMaxCoverImageSizeBytes() + 1024;

  constructor(private readonly companiesService: CompaniesService) {}

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Obtener la company autenticada' })
  @ApiResponse({ status: HttpStatus.OK, type: CompanyResponseDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No se encontró información de la empresa',
  })
  async getCurrent(@CurrentCompany() companyId: number): Promise<CompanyResponseDto> {
    const company = await this.companiesService.getCurrent(companyId);
    const coverUrl = await this.companiesService.resolveCatalogCoverUrl(company);
    return toCompanyResponseDto(company, coverUrl);
  }

  @Put(':companyId')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({ summary: 'Actualizar la company autenticada' })
  @ApiParam({ name: 'companyId', type: 'integer' })
  @ApiBody({ type: UpdateCompanyDto })
  @ApiResponse({ status: HttpStatus.OK, type: CompanyResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Operación cross-tenant prohibida',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No se encontró información de la empresa',
  })
  async update(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: UpdateCompanyDto,
    @CurrentCompany() tenantCompanyId: number,
  ): Promise<CompanyResponseDto> {
    // Anti-IDOR: aunque la URL preserve la firma PlacePos (`PUT /:id`),
    // el `:companyId` DEBE coincidir con la company del JWT.
    if (companyId !== tenantCompanyId) {
      throw new ForbiddenException('Operación cross-tenant prohibida');
    }

    const company = await this.companiesService.update(tenantCompanyId, dto);
    return toCompanyResponseDto(company);
  }

  /**
   * Comprueba si un slug de catálogo está disponible (para validar en vivo
   * mientras el dueño escribe en Configuraciones → Catálogo). Devuelve el slug
   * ya NORMALIZADO, si cumple el formato y si está libre.
   */
  @Get('catalog/slug-available')
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({ summary: 'Disponibilidad de un slug de catálogo' })
  @ApiQuery({ name: 'slug', type: 'string', required: true })
  async checkCatalogSlug(
    @Query('slug') slug: string,
    @CurrentCompany() companyId: number,
  ): Promise<SlugAvailability> {
    return this.companiesService.checkCatalogSlug(companyId, slug ?? '');
  }

  /**
   * Configura el catálogo público del negocio: define/normaliza el slug y
   * habilita o deshabilita la publicación. Mismo gate que Mi Negocio
   * (`canAccessSettings`).
   */
  @Patch('catalog')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({ summary: 'Configurar el catálogo público del negocio' })
  @ApiBody({ type: UpdateCatalogSettingsDto })
  @ApiResponse({ status: HttpStatus.OK, type: CompanyResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Slug inválido o falta slug' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Slug ya en uso' })
  async updateCatalog(
    @Body() dto: UpdateCatalogSettingsDto,
    @CurrentCompany() companyId: number,
  ): Promise<CompanyResponseDto> {
    const company = await this.companiesService.updateCatalogSettings(companyId, dto);
    const coverUrl = await this.companiesService.resolveCatalogCoverUrl(company);
    return toCompanyResponseDto(company, coverUrl);
  }

  /**
   * `POST /companies/catalog/cover` — Sube o reemplaza la imagen de PORTADA
   * (hero) del catálogo público. Multipart con el campo `image` (JPG/PNG/WebP,
   * validado por los bytes reales). La portada anterior se borra del bucket.
   */
  @Post('catalog/cover')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: CompaniesController.MULTER_COVER_CEILING_BYTES, files: 1 },
    }),
  )
  @ApiOperation({ summary: 'Subir o reemplazar la portada del catálogo' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { image: { type: 'string', format: 'binary' } },
      required: ['image'],
    },
  })
  @ApiResponse({ status: HttpStatus.OK, type: CompanyResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Archivo ausente o formato inválido' })
  @ApiResponse({ status: HttpStatus.PAYLOAD_TOO_LARGE, description: 'La imagen supera el límite' })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Almacenamiento de imágenes no configurado',
  })
  async uploadCatalogCover(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CompanyResponseDto> {
    const { company, cover_image_url } = await this.companiesService.uploadCatalogCover({
      companyId,
      file,
      actor: {
        id: currentUser.user_id,
        fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      },
    });
    return toCompanyResponseDto(company, cover_image_url);
  }

  /**
   * `POST /companies/catalog/cover/remove` — Quita la portada del catálogo (la
   * borra del bucket). Idempotente. Es POST y no DELETE por convención del API.
   */
  @Post('catalog/cover/remove')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({ summary: 'Quitar la portada del catálogo' })
  @ApiResponse({ status: HttpStatus.OK, type: CompanyResponseDto })
  async removeCatalogCover(@CurrentCompany() companyId: number): Promise<CompanyResponseDto> {
    const company = await this.companiesService.removeCatalogCover(companyId);
    const coverUrl = await this.companiesService.resolveCatalogCoverUrl(company);
    return toCompanyResponseDto(company, coverUrl);
  }
}
