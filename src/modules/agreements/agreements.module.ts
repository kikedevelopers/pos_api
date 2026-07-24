import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AcceptAgreementAction } from './actions/accept-agreement.action';
import { ListAcceptancesAction } from './actions/list-acceptances.action';
import { AgreementsController } from './agreements.controller';
import { AgreementsService } from './agreements.service';
import { AgreementAcceptance } from './entities/agreement-acceptance.entity';

/**
 * Módulo `agreements` — aceptaciones de disclaimers / términos y condiciones por
 * usuario. Diseño genérico y extensible: agregar un acuerdo nuevo NO toca el
 * esquema (solo una `agreement_key` + `version` nuevas en el front).
 */
@Module({
  imports: [TypeOrmModule.forFeature([AgreementAcceptance])],
  controllers: [AgreementsController],
  providers: [AgreementsService, ListAcceptancesAction, AcceptAgreementAction],
  exports: [AgreementsService],
})
export class AgreementsModule {}
