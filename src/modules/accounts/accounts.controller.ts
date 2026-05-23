import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { AccountsService, type TransferResult } from './accounts.service';
import type { TransferDestinationItem } from './actions/get-transfer-destinations.action';
import { TransferDestinationsQueryDto } from './dto/transfer-destinations-query.dto';
import { TransferDto } from './dto/transfer.dto';

/**
 * Endpoints `/accounts`. Espejo `accounts.routes.ts` de PlacePos.
 *
 *   - `GET /accounts/transfer-destinations?sourceType=&sourceId=` →
 *     `{ destinations: [...] }`.
 *   - `POST /accounts/transfer` → ejecuta el traslado atómicamente.
 *
 * Roles:
 *   - Transfer-destinations: cualquier autenticado puede consultar
 *     (necesario para que el frontend pinte el selector).
 *   - Transfer: `owner` y `manager`. El `employee` (caja) no traslada
 *     dinero entre cuentas administrativas — eso lo decide quien
 *     administra el negocio.
 */
@ApiTags('accounts')
@ApiBearerAuth('bearer')
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get('transfer-destinations')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Lista de cuentas destino disponibles para una fuente.' })
  @ApiResponse({ status: HttpStatus.OK })
  async getTransferDestinations(
    @Query() query: TransferDestinationsQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<{ destinations: TransferDestinationItem[] }> {
    return this.accountsService.getTransferDestinations(
      companyId,
      query.sourceType,
      query.sourceId,
    );
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Transferir dinero entre cuentas (bank/wallet/user) de la company.',
    description:
      'En UNA transacción: valida balances, debita el origen, acredita el destino y genera DOS FinancialMovement (EXPENSE + INCOME) con el mismo reference_code. Si destino=user, también INSERT CashRegisterLog en la caja del destinatario.',
  })
  @ApiBody({ type: TransferDto })
  @ApiResponse({ status: HttpStatus.OK, description: '{ message, source, destination }' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cuenta origen/destino no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Saldo insuficiente / monto inválido / source === destination',
  })
  async transfer(
    @Body() dto: TransferDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<TransferResult> {
    return this.accountsService.transfer(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
  }
}
