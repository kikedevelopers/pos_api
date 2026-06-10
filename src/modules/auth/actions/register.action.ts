import { ConflictException, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DataSource, QueryFailedError } from 'typeorm';

import { ARGON2_OPTIONS } from '@/common/utils/argon2-options';
import { CompanyMember } from '@/modules/companies/entities/company-member.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { CreateSubscriptionAction } from '@/modules/subscriptions/actions/create-subscription.action';
import {
  SUBSCRIPTION_MIGRATION_DAYS,
  SUBSCRIPTION_TRIAL_DAYS,
} from '@/modules/subscriptions/subscriptions.constants';
import { User, UserType } from '@/modules/users/entities/user.entity';

import type { AuthResponseDto } from '../dto/auth-response.dto';
import type { RegisterDto } from '../dto/register.dto';
import { userToAuthUserDto } from '../internal/auth-mappers';
import { JwtIssuerService } from '../internal/jwt-issuer.service';
import { PG_UNIQUE_VIOLATION } from '../internal/pg-errors';
import { SeedCompanyAction } from './seed-company.action';

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
    private readonly seedCompanyAction: SeedCompanyAction,
    private readonly createSubscriptionAction: CreateSubscriptionAction,
  ) {}

  async execute(dto: RegisterDto): Promise<AuthResponseDto> {
    // Hashing FUERA de la transacción: argon2 toma ~50-100ms y mantener una
    // conexión abierta esperándolo bloquea el pool. Si la transacción falla
    // después, el hash se descarta — costo aceptable.
    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

    // Cuenta creada desde un POS offline (placepos) en su primera migración a
    // cloud: marca la company y acorta el trial. Flag auto-protegido (pedir
    // MENOS días no abre superficie de abuso), por eso es público sin gating.
    const fromOfflineMigration = dto.from_offline_migration === true;

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
        // `offline_migration` si la cuenta nace de la migración de un POS
        // offline; `web` para el registro normal. TypeORM 0.3 no aplica el
        // default SQL si la columna no aparece en `create()`, por eso se setea
        // explícito.
        origin: fromOfflineMigration ? 'offline_migration' : 'web',
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

      const companyId = Number(savedCompany.id);
      const createdBy = {
        id: Number(saved.id),
        fullName: `${saved.name} ${saved.lastname}`.trim(),
      };

      // 4. Membresía del owner con su negocio principal. Fuente de verdad para
      //    resolver la suscripción aplicable (sucursales la comparten) y
      //    autorizar el switch de sucursal.
      await manager.save(
        CompanyMember,
        manager.create(CompanyMember, {
          user_id: String(saved.id),
          company_id: savedCompany.id,
          role: 'owner',
        }),
      );

      // 5. Seeds esenciales (wallet, ticket_settings, app_settings,
      //    alert_configs). Comparten el `manager`: rollback total si algo falla.
      await this.seedCompanyAction.execute(manager, { companyId, createdBy });

      // 6. Suscripción ÚNICA del owner — vive en el negocio principal y cubre
      //    también sus futuras sucursales. Registro normal = 10 días; migración
      //    desde POS offline = 1 día. Cuando vence se bloquea TODA la cuenta.
      await this.createSubscriptionAction.execute(manager, {
        companyId,
        ownerUserId: Number(saved.id),
        startedAt: new Date(),
        durationDays: fromOfflineMigration
          ? SUBSCRIPTION_MIGRATION_DAYS
          : SUBSCRIPTION_TRIAL_DAYS,
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
