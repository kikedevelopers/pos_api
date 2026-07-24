import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { AcceptAgreementDto } from './dto/accept-agreement.dto';
import {
  AgreementAcceptanceResponseDto,
  toAgreementAcceptanceResponseDto,
} from './dto/agreement-acceptance-response.dto';
import { AgreementsService } from './agreements.service';

/**
 * Endpoints de `/agreements` — aceptaciones de disclaimers / T&C por usuario.
 *
 * El contenido de cada acuerdo vive en el front (por `key` + `version`); aquí
 * solo se registra qué aceptó el usuario autenticado. Cualquier rol puede leer
 * y aceptar (es un consentimiento personal, no configuración del negocio). El
 * usuario/company salen SIEMPRE del JWT (anti-IDOR).
 */
@ApiTags('agreements')
@ApiBearerAuth('bearer')
@Controller('agreements')
export class AgreementsController {
  constructor(private readonly agreementsService: AgreementsService) {}

  @Get('acceptances')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Acuerdos aceptados por el usuario autenticado' })
  @ApiResponse({ status: HttpStatus.OK, type: [AgreementAcceptanceResponseDto] })
  async listAcceptances(
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<AgreementAcceptanceResponseDto[]> {
    const rows = await this.agreementsService.listAcceptances(companyId, user);
    return rows.map(toAgreementAcceptanceResponseDto);
  }

  @Post('accept')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Registrar la aceptación de un acuerdo' })
  @ApiBody({ type: AcceptAgreementDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: AgreementAcceptanceResponseDto })
  async accept(
    @Body() dto: AcceptAgreementDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<AgreementAcceptanceResponseDto> {
    const row = await this.agreementsService.accept(dto, companyId, user);
    return toAgreementAcceptanceResponseDto(row);
  }
}
