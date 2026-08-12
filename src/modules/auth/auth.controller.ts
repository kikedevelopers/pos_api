import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { SkipActiveCompanyCheck } from '@/common/decorators/skip-active-company-check.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { AuthService } from './auth.service';
import {
  ActivateAccountResponseDto,
  AuthResponseDto,
  MeResponseDto,
  ProfileResponseDto,
  RegisterResponseDto,
} from './dto/auth-response.dto';
import { CheckEmailDto, CheckEmailResponseDto } from './dto/check-email.dto';
import { LoginDto } from './dto/login.dto';
import { ActivateAccountDto } from './dto/activate-account.dto';
import { RegisterDto } from './dto/register.dto';

/**
 * Endpoints de autenticación.
 *
 * Espejo del contrato PlacePos (`auth.routes.ts`), con UN único endpoint
 * nuevo (`POST /auth/register`) que solo existe en modo CLOUD.
 *
 * Todos los responses salen envueltos por `ResponseWrapperInterceptor` en
 * `{ success: true, payload: <esto> }`. Los `@ApiResponse` documentan el
 * shape interno (sin el wrapper) — el wrapper se documenta una sola vez en
 * el Swagger root para no contaminar cada endpoint.
 */
@ApiTags('auth')
@Controller('auth')
// /auth/* (perfil, me, logout) debe leerse aunque el JWT apunte a una sucursal
// suspendida — el cliente necesita el perfil para detectarlo y recuperarse.
@SkipActiveCompanyCheck()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Public()
  @ApiOperation({
    summary: 'Crear cuenta (owner + company)',
    description:
      'Crea atómicamente un User con rol `owner` y su Company, y envía el correo ' +
      'de activación. NO devuelve JWT: la cuenta no puede iniciar sesión hasta ' +
      'que se canjee el enlace en `POST /auth/activate`.',
  })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Cuenta creada, pendiente de activación',
    type: RegisterResponseDto,
  })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Email ya registrado (code: EMAIL_TAKEN)',
  })
  register(@Body() dto: RegisterDto): Promise<RegisterResponseDto> {
    return this.authService.register(dto);
  }

  @Post('activate')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activar la cuenta con el token del correo de bienvenida',
    description:
      'Canjea el enlace de un solo uso y habilita el login. Responde 200 con ' +
      '`already_activated: true` si la cuenta ya estaba activa (doble clic), ' +
      'porque eso no es un error para quien lo hace.',
  })
  @ApiBody({ type: ActivateAccountDto })
  @ApiResponse({ status: HttpStatus.OK, type: ActivateAccountResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Token inválido, vencido o ya usado (code: ACTIVATION_TOKEN_*)',
  })
  activate(@Body() dto: ActivateAccountDto): Promise<ActivateAccountResponseDto> {
    return this.authService.activate(dto.token);
  }

  @Post('check/email')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Throttle propio: el frontend lo llama mientras el usuario tipea el email
  // en el formulario. 30/min es generoso para UX y suficiente para frenar un
  // intento de enumeración masiva (el atacante aún tendría que pasar el
  // throttler global de 100/min).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Verificar si un email ya está registrado',
    description:
      'Cross-company por diseño: `users.email` es UNIQUE GLOBAL. Devuelve ' +
      '`{ available: boolean, message: string }` — paridad cliente PlacePos.',
  })
  @ApiBody({ type: CheckEmailDto })
  @ApiResponse({ status: HttpStatus.OK, type: CheckEmailResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Email inválido' })
  @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, description: 'Rate limit' })
  checkEmail(@Body() dto: CheckEmailDto): Promise<CheckEmailResponseDto> {
    return this.authService.checkEmail(dto);
  }

  @Post('user')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Override del throttler global: 10 intentos/minuto específicos para login.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Login (User o Employee)' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: HttpStatus.OK, description: 'Autenticado', type: AuthResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Credenciales inválidas' })
  @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, description: 'Rate limit' })
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
  }

  @Get('me')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Snapshot del usuario autenticado' })
  @ApiResponse({ status: HttpStatus.OK, type: MeResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async me(@CurrentUser() user: AuthUser): Promise<MeResponseDto> {
    // Paridad PlacePos local (`auth.routes.ts:193`): el cliente lee
    // `data.payload.user`. Envolvemos en el controller para mantener la
    // action `GetMe` reutilizable como AuthUserDto plano.
    return { user: await this.authService.getMe(user) };
  }

  @Get('profile')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Perfil completo: usuario + company' })
  @ApiResponse({ status: HttpStatus.OK, type: ProfileResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'User o Company inexistente' })
  profile(@CurrentUser() user: AuthUser): Promise<ProfileResponseDto> {
    return this.authService.getProfile(user);
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Logout (stateless)',
    description:
      'JWT es stateless. El cliente descarta el token. El endpoint existe por paridad de contrato.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Logout' })
  logout(): null {
    // ResponseWrapperInterceptor convierte `null` en `{ success: true, payload: null }`.
    return null;
  }
}
