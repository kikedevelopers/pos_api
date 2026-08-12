import { Injectable } from '@nestjs/common';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CheckEmailAction } from './actions/check-email.action';
import { GetMeAction } from './actions/get-me.action';
import { GetProfileAction } from './actions/get-profile.action';
import { ActivateAccountAction } from './actions/activate-account.action';
import { RequestPasswordResetAction } from './actions/request-password-reset.action';
import { ResetPasswordAction } from './actions/reset-password.action';
import { LoginAction } from './actions/login.action';
import { RegisterAction } from './actions/register.action';
import type {
  ActivateAccountResponseDto,
  ForgotPasswordResponseDto,
  ResetPasswordResponseDto,
  AuthResponseDto,
  AuthUserDto,
  ProfileResponseDto,
  RegisterResponseDto,
} from './dto/auth-response.dto';
import type { CheckEmailDto, CheckEmailResponseDto } from './dto/check-email.dto';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

/**
 * Facade delgado del dominio `auth`. ZERO lógica de negocio — solo delega a
 * la action correspondiente. Patrón §3.1 del CLAUDE.md.
 *
 * Razón de existir: el controller inyecta UN service (firma estable del
 * contrato HTTP). Los tests unitarios apuntan a las actions; los e2e cubren
 * el service por debajo.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly registerAction: RegisterAction,
    private readonly loginAction: LoginAction,
    private readonly activateAccountAction: ActivateAccountAction,
    private readonly requestPasswordResetAction: RequestPasswordResetAction,
    private readonly resetPasswordAction: ResetPasswordAction,
    private readonly getMeAction: GetMeAction,
    private readonly getProfileAction: GetProfileAction,
    private readonly checkEmailAction: CheckEmailAction,
  ) {}

  register(dto: RegisterDto): Promise<RegisterResponseDto> {
    // Sin `skipActivation`, la action SIEMPRE devuelve la respuesta con
    // `activation_required`. El camino que sí emite JWT es exclusivo del panel
    // superadmin, que llama a la action directamente.
    return this.registerAction.execute(dto) as Promise<RegisterResponseDto>;
  }

  activate(token: string): Promise<ActivateAccountResponseDto> {
    return this.activateAccountAction.execute(token);
  }

  forgotPassword(email: string): Promise<ForgotPasswordResponseDto> {
    return this.requestPasswordResetAction.execute(email);
  }

  resetPassword(token: string, password: string): Promise<ResetPasswordResponseDto> {
    return this.resetPasswordAction.execute(token, password);
  }

  login(dto: LoginDto): Promise<AuthResponseDto> {
    return this.loginAction.execute(dto);
  }

  getMe(authUser: AuthUser): Promise<AuthUserDto> {
    return this.getMeAction.execute(authUser);
  }

  getProfile(authUser: AuthUser): Promise<ProfileResponseDto> {
    return this.getProfileAction.execute(authUser);
  }

  checkEmail(dto: CheckEmailDto): Promise<CheckEmailResponseDto> {
    return this.checkEmailAction.execute(dto);
  }
}
