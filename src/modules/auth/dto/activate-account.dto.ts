import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

/**
 * Payload de `POST /auth/activate`: el token que viajó en el enlace del correo
 * de bienvenida.
 *
 * Va en el CUERPO, no en la query, a propósito: las URLs quedan en los logs del
 * servidor, en el historial del navegador y en la cabecera `Referer` de
 * cualquier recurso externo que cargue la página. El token es una credencial de
 * un solo uso, así que la página de activación lo lee de su propia URL y lo
 * reenvía aquí por POST.
 */
export class ActivateAccountDto {
  @ApiProperty({
    example: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    description: 'Token de activación (64 caracteres hexadecimales).',
  })
  @IsString()
  @Length(64, 64, { message: 'token debe tener 64 caracteres' })
  @Matches(/^[0-9a-fA-F]+$/, { message: 'token debe ser hexadecimal' })
  token!: string;
}
