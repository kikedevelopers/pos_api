import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import 'dayjs/locale/es';

import { Company } from '@/modules/companies/entities/company.entity';

import { dayjs } from '@/common/utils/dayjs';

import { ALERT_TYPE_CREDIT_DUE_TODAY } from '../constants';
import { buildCreditsDueTodayPdf } from '../internal/credits-pdf';
import { buildMockCreditsDueToday } from '../internal/mock-credits';
import { AlertPdfTokenService } from '../internal/alert-pdf-token.service';
import { GetCreditsDueTodayAction } from './get-credits-due-today.action';

/**
 * Genera, A DEMANDA, el PDF de "créditos que vencen hoy" a partir del token del
 * enlace del correo. El PDF NO se guarda en ningún lado: se arma y se devuelve.
 * El token (firmado) lleva la company, la fecha y el tipo; aquí se valida,
 * se descompone, se consulta y se construye el PDF.
 */
@Injectable()
export class GenerateCreditsPdfFromTokenAction {
  constructor(
    private readonly tokenService: AlertPdfTokenService,
    private readonly getCreditsDueToday: GetCreditsDueTodayAction,
    @InjectRepository(Company) private readonly companiesRepo: Repository<Company>,
  ) {}

  async execute(token: string): Promise<{ buffer: Buffer; filename: string }> {
    if (!token || token.trim() === '') {
      throw new BadRequestException('Falta el token del enlace.');
    }

    let payload;
    try {
      payload = await this.tokenService.verify(token);
    } catch {
      throw new UnauthorizedException('El enlace es inválido o ya expiró.');
    }

    if (payload.type !== ALERT_TYPE_CREDIT_DUE_TODAY) {
      throw new BadRequestException('Tipo de reporte no soportado.');
    }

    const summary = payload.mock
      ? buildMockCreditsDueToday(payload.date)
      : await this.getCreditsDueToday.execute(payload.cid, payload.date);

    const company = await this.companiesRepo.findOne({ where: { id: String(payload.cid) } });
    const dateLabel = dayjs(payload.date).locale('es').format('DD [de] MMMM [de] YYYY');

    const buffer = await buildCreditsDueTodayPdf({
      company: {
        name: company?.name ?? 'Tu negocio',
        documentNumber: company?.document_number ?? null,
        address: company?.address ?? null,
        phone: company?.phone_number ?? null,
        email: company?.email ?? null,
      },
      dateLabel,
      rows: summary.rows,
      totalBalance: summary.totalBalance,
    });

    return { buffer, filename: `creditos-vencen-${payload.date}.pdf` };
  }
}
