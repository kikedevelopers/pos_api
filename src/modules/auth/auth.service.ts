import { Injectable } from '@nestjs/common';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CheckEmailAction } from './actions/check-email.action';
import { GetMeAction } from './actions/get-me.action';
import { GetProfileAction } from './actions/get-profile.action';
import { LoginAction } from './actions/login.action';
import { RegisterAction } from './actions/register.action';
import type { AuthResponseDto, AuthUserDto, ProfileResponseDto } from './dto/auth-response.dto';
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
    private readonly getMeAction: GetMeAction,
    private readonly getProfileAction: GetProfileAction,
    private readonly checkEmailAction: CheckEmailAction,
  ) {}

  register(dto: RegisterDto): Promise<AuthResponseDto> {
    return this.registerAction.execute(dto);
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
