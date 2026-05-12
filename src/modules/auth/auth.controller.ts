import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Public } from '@/common/decorators/public.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { AuthService } from './auth.service';
import { AuthResponseDto, AuthUserDto, ProfileResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
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
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Public()
  @ApiOperation({
    summary: 'Crear cuenta (owner + company)',
    description:
      'Crea atómicamente un User con rol `owner` y su Company. Devuelve un JWT igual al de login.',
  })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Cuenta creada', type: AuthResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Email ya registrado (code: EMAIL_TAKEN)',
  })
  register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(dto);
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
  @ApiResponse({ status: HttpStatus.OK, type: AuthUserDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  me(@CurrentUser() user: AuthUser): Promise<AuthUserDto> {
    return this.authService.getMe(user);
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
