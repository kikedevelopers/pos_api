import { ConflictException, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DataSource, QueryFailedError } from 'typeorm';

import { ARGON2_OPTIONS } from '@/common/utils/argon2-options';
import { CreateDefaultAlertConfigsAction } from '@/modules/alert-configs/actions/create-default-alert-configs.action';
import { CreateDefaultAppSettingsAction } from '@/modules/app-settings/actions/create-default-app-settings.action';
import { Company } from '@/modules/companies/entities/company.entity';
import { CreateSubscriptionAction } from '@/modules/subscriptions/actions/create-subscription.action';
import { CreateDefaultTicketSettingsAction } from '@/modules/ticket-settings/actions/create-default-ticket-settings.action';
import { User, UserType } from '@/modules/users/entities/user.entity';
import { CreateDefaultWalletAction } from '@/modules/wallets/actions/create-default-wallet.action';

import type { AuthResponseDto } from '../dto/auth-response.dto';
import type { RegisterDto } from '../dto/register.dto';
import { userToAuthUserDto } from '../internal/auth-mappers';
import { JwtIssuerService } from '../internal/jwt-issuer.service';
import { PG_UNIQUE_VIOLATION } from '../internal/pg-errors';

/**
 * Registra un nuevo `owner` + `company` atómicamente. Devuelve el JWT y el
 * snapshot del usuario, igual que el flujo de login.
 *
 * Errores:
 *   - 409 `EMAIL_TAKEN` si el email ya pertenece a otro user.
 *     Dos vías de detección:
 *       1. Fast-path: `findOne(email)` previo al INSERT (ahorra hashing).
 *       2. Hard-path: catch `QueryFailedError` con `code = 23505` cuando dos
 *          POST concurrentes pasan ambos por el fast-path antes del primer
 *          INSERT (race condition).
 *
 * Transacción: requerida — escribe Company + User + (Fase 5/10) seeds
 * esenciales. Si cualquier paso falla, rollback total.
 */
@Injectable()
export class RegisterAction {
  private readonly logger = new Logger(RegisterAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly jwtIssuer: JwtIssuerService,
    private readonly createDefaultWalletAction: CreateDefaultWalletAction,
    private readonly createDefaultTicketSettingsAction: CreateDefaultTicketSettingsAction,
    private readonly createDefaultAppSettingsAction: CreateDefaultAppSettingsAction,
    private readonly createDefaultAlertConfigsAction: CreateDefaultAlertConfigsAction,
    private readonly createSubscriptionAction: CreateSubscriptionAction,
  ) {}

  async execute(dto: RegisterDto): Promise<AuthResponseDto> {
    // Hashing FUERA de la transacción: argon2 toma ~50-100ms y mantener una
    // conexión abierta esperándolo bloquea el pool. Si la transacción falla
    // después, el hash se descarta — costo aceptable.
    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

    const savedUser = await this.dataSource.transaction<User>(async (manager) => {
      // 1. Fast-path: verificar que el email no esté tomado antes de insertar.
      const existing = await manager.findOne(User, { where: { email: dto.email } });
      if (existing) {
        throw new ConflictException({
          message: 'Ya existe una cuenta con ese email',
          payload: { code: 'EMAIL_TAKEN' },
        });
      }

      // 2. Crear company. El cliente CLOUD solo envía `company_name`; el
      // resto de campos opcionales (document_number, address, email,
      // phone_number) se completan después vía `PUT /companies`.
      const company = manager.create(Company, {
        name: dto.company_name,
        document_number: null,
        address: null,
        email: null,
        phone_number: null,
        // TypeORM 0.3 NO aplica defaults SQL si la columna no aparece en
        // `create()` — el INSERT escribe NULL explícito. Seteamos los tres
        // numéricos NOT NULL.
        balance: 0,
        break_even_amount: 0,
        break_even_period_days: 30,
      });
      const savedCompany = await manager.save(Company, company);

      // 3. Crear user owner.
      const user = manager.create(User, {
        name: dto.name,
        lastname: dto.lastname,
        email: dto.email,
        password: passwordHash,
        type: UserType.OWNER,
        company_id: savedCompany.id,
        // TypeORM 0.3 no aplica defaults SQL si el campo no aparece en create().
        balance: 0,
      });

      let saved: User;
      try {
        saved = await manager.save(User, user);
      } catch (error) {
        // Hard-path: race condition. Otro POST concurrente insertó el mismo
        // email entre nuestro fast-path y este INSERT. `dataSource.transaction`
        // propagará el throw y hará rollback automático de la company creada.
        if (error instanceof QueryFailedError) {
          const code = (error as QueryFailedError & { code?: string }).code;
          if (code === PG_UNIQUE_VIOLATION) {
            throw new ConflictException({
              message: 'Ya existe una cuenta con ese email',
              payload: { code: 'EMAIL_TAKEN' },
            });
          }
        }
        throw error;
      }

      // 4. Seeds esenciales — todos comparten el `manager` con la transacción
      //    del registro, así que si falla cualquier paso posterior se hace
      //    rollback de Company + User + todos los seeds juntos.
      const createdBy = {
        id: Number(saved.id),
        fullName: `${saved.name} ${saved.lastname}`.trim(),
      };
      const companyId = Number(savedCompany.id);

      // 4.1. Wallet "Efectivo" balance 0 (Fase 5).
      await this.createDefaultWalletAction.execute(manager, { companyId, createdBy });

      // 4.2. TicketSettings (Fase 10): 5 rows (ORDER/SALE/CREDIT_NOTE/
      //      DEBIT_NOTE/PURCHASE) con current_number=0. Pre-requisito para
      //      que cualquier endpoint que genere folios (ventas, compras,
      //      notas) pueda incrementar atómicamente sin race condition.
      await this.createDefaultTicketSettingsAction.execute(manager, { companyId, createdBy });

      // 4.3. AppSettings defaults (Fase 10): app_color_mode='white',
      //      pos_margins_enabled='false'. El cliente lee estos valores en
      //      el primer login y aplica la UI correspondiente.
      await this.createDefaultAppSettingsAction.execute(manager, { companyId, createdBy });

      // 4.4. AlertConfigs defaults: INACTIVE_CUSTOMER deshabilitado por
      //      defecto. Paridad placepos (`seeds/alertConfigs.ts`). El dueño
      //      lo activa cuando quiera recibir el resumen diario.
      await this.createDefaultAlertConfigsAction.execute(manager, { companyId, createdBy });

      // 4.5. Suscripción (cloud-only): trial de gracia de 10 días desde ahora.
      //      Va dentro de la MISMA transacción — si falla cualquier paso, la
      //      suscripción se revierte junto con Company + User + seeds. Cuando
      //      `expires_at < now()` la company queda bloqueada (guard + login).
      await this.createSubscriptionAction.execute(manager, {
        companyId,
        ownerUserId: Number(saved.id),
        startedAt: new Date(),
      });

      return saved;
    });

    const access_token = await this.jwtIssuer.sign({
      userId: savedUser.id,
      companyId: savedUser.company_id,
      name: savedUser.name,
      lastname: savedUser.lastname,
      type: savedUser.type,
      account: 'user',
    });

    return {
      access_token,
      user: userToAuthUserDto(savedUser, this.logger),
    };
  }
}
