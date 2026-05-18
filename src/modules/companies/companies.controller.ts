import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { CompaniesService } from './companies.service';
import { CompanyResponseDto, toCompanyResponseDto } from './dto/company-response.dto';
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
 *   - `PUT`: solo `owner`. Editar perfil del negocio es atributo de dueño;
 *     manager y employee no tocan esta tabla.
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
    return toCompanyResponseDto(company);
  }

  @Put(':companyId')
  @HttpCode(HttpStatus.OK)
  @Roles('owner')
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
}
