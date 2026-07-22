import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { CreateSupplierDto } from '../dto/create-supplier.dto';
import { UpdateSupplierDto } from '../dto/update-supplier.dto';

/**
 * Tests unitarios (CI-safe, SIN BD) de la validación del DTO de
 * `POST /suppliers`. Reproducen lo que hace el `ValidationPipe` global
 * (`main.ts`): `plainToInstance` + `validate` con `{ whitelist: true }`.
 *
 * El caso que motivó estos tests: **crear un proveedor solo con la razón
 * social debe bastar**. El formulario mandaba `email: ''` y `@IsOptional()`
 * solo salta `null`/`undefined`, así que la cadena vacía llegaba a `@IsEmail`
 * y tumbaba el create ENTERO con un 400. El fix usa `@ValidateIf`.
 */
const VALIDATE_OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;

const errorsOf = async (payload: Record<string, unknown>): Promise<ValidationError[]> =>
  validate(plainToInstance(CreateSupplierDto, payload), VALIDATE_OPTS);

const messagesOf = async (payload: Record<string, unknown>): Promise<string[]> => {
  const errors = await errorsOf(payload);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
};

describe('CreateSupplierDto', () => {
  describe('crear con solo la razón social basta', () => {
    it('acepta solo `legal_name` (sin correo ni nada más)', async () => {
      await expect(errorsOf({ legal_name: 'PROVEEDOR FULANO' })).resolves.toEqual([]);
    });

    it('acepta el correo vacío junto al resto de datos', async () => {
      await expect(
        errorsOf({
          legal_name: 'PROVEEDOR FULANO',
          broker: '',
          doc_number: '',
          phone: '',
          email: '',
          address: '',
          payment_accounts: [],
        }),
      ).resolves.toEqual([]);
    });

    it('acepta el correo en null (borrarlo explícitamente)', async () => {
      await expect(errorsOf({ legal_name: 'PROVEEDOR FULANO', email: null })).resolves.toEqual([]);
    });

    it('acepta que el correo NO venga en el payload', async () => {
      await expect(errorsOf({ legal_name: 'PROVEEDOR FULANO' })).resolves.toEqual([]);
    });
  });

  describe('el correo, si viene con valor, se valida', () => {
    it('acepta un correo válido', async () => {
      await expect(
        errorsOf({ legal_name: 'PROVEEDOR FULANO', email: 'contacto@distcaracas.com' }),
      ).resolves.toEqual([]);
    });

    it.each(['no-es-un-correo', 'sin@dominio', '@sindestinatario.com', 'espacio @dominio.com'])(
      'rechaza un correo inválido: %s',
      async (email) => {
        await expect(messagesOf({ legal_name: 'PROVEEDOR FULANO', email })).resolves.toContain(
          'email debe ser una dirección de correo válida',
        );
      },
    );
  });

  describe('legal_name (razón social)', () => {
    it('es obligatorio: rechaza el vacío', async () => {
      await expect(messagesOf({ legal_name: '' })).resolves.toContain(
        'La razón social es requerida',
      );
    });

    it('es obligatorio: rechaza que no venga', async () => {
      const msgs = await messagesOf({ email: 'contacto@distcaracas.com' });
      expect(msgs.some((m) => m.includes('razón social') || m.toLowerCase().includes('empty'))).toBe(
        true,
      );
    });
  });

  describe('whitelist', () => {
    it('rechaza propiedades desconocidas', async () => {
      const errors = await errorsOf({ legal_name: 'X', accumulated_debt: 999999 });
      expect(errors.flatMap((e) => Object.keys(e.constraints ?? {}))).toContain(
        'whitelistValidation',
      );
    });
  });
});

describe('UpdateSupplierDto (hereda las mismas reglas vía PartialType)', () => {
  const updateErrorsOf = async (payload: Record<string, unknown>): Promise<ValidationError[]> =>
    validate(plainToInstance(UpdateSupplierDto, payload), VALIDATE_OPTS);

  it('editar dejando el correo vacío no falla', async () => {
    await expect(updateErrorsOf({ legal_name: 'PROVEEDOR FULANO', email: '' })).resolves.toEqual([]);
  });

  it('PUT con `{}` es válido (no toca nada)', async () => {
    await expect(updateErrorsOf({})).resolves.toEqual([]);
  });

  it('sigue validando un correo con valor inválido', async () => {
    const errors = await updateErrorsOf({ email: 'no-es-un-correo' });
    expect(errors.flatMap((e) => Object.values(e.constraints ?? {}))).toContain(
      'email debe ser una dirección de correo válida',
    );
  });
});
