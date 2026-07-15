import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { UpdateCompanyDto } from '../dto/update-company.dto';

/**
 * Tests unitarios (CI-safe, SIN BD) de la validación del DTO de
 * `PUT /companies/:companyId`. Reproducen lo que hace el `ValidationPipe`
 * global (`main.ts`): `plainToInstance` + `validate` con `{ whitelist: true }`.
 *
 * El caso que motivó estos tests: **el correo es opcional**. Guardar solo
 * dirección y teléfono, dejando el correo en blanco, reventaba con 400 porque
 * `@IsOptional()` solo salta `null`/`undefined` — la cadena vacía que manda el
 * formulario llegaba a `@IsEmail` y tumbaba el update ENTERO. El action ya
 * documenta que `''` se persiste como `null`; el DTO contradecía ese contrato.
 */
const VALIDATE_OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;

const errorsOf = async (payload: Record<string, unknown>): Promise<ValidationError[]> =>
  validate(plainToInstance(UpdateCompanyDto, payload), VALIDATE_OPTS);

const messagesOf = async (payload: Record<string, unknown>): Promise<string[]> => {
  const errors = await errorsOf(payload);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
};

describe('UpdateCompanyDto', () => {
  describe('el correo es OPCIONAL', () => {
    it('acepta el correo vacío: se puede guardar sin él', async () => {
      // El caso reportado: solo dirección y teléfono, correo en blanco.
      await expect(
        errorsOf({ name: 'Esencia & Grano', address: 'Calle 123', phone_number: '3132531430', email: '' }),
      ).resolves.toEqual([]);
    });

    it('acepta que el correo NO venga en el payload', async () => {
      await expect(errorsOf({ name: 'Esencia & Grano', address: 'Calle 123' })).resolves.toEqual([]);
    });

    it('acepta el correo en null (borrarlo explícitamente)', async () => {
      await expect(errorsOf({ name: 'Esencia & Grano', email: null })).resolves.toEqual([]);
    });

    it('un payload SOLO con el correo vacío tampoco falla', async () => {
      await expect(errorsOf({ email: '' })).resolves.toEqual([]);
    });
  });

  describe('el correo, si viene con valor, se valida', () => {
    it('acepta un correo válido', async () => {
      await expect(errorsOf({ email: 'contacto@minegocio.com' })).resolves.toEqual([]);
    });

    it.each(['no-es-un-correo', 'sin@dominio', '@sindestinatario.com', 'espacio @dominio.com'])(
      'rechaza un correo inválido: %s',
      async (email) => {
        await expect(messagesOf({ email })).resolves.toContain(
          'email debe ser una dirección de correo válida',
        );
      },
    );
  });

  describe('el resto de campos opcionales admiten vacío (se persisten como null)', () => {
    it.each(['document_number', 'address', 'phone_number'])('%s vacío no falla', async (field) => {
      await expect(errorsOf({ [field]: '' })).resolves.toEqual([]);
    });
  });

  describe('name', () => {
    it('sigue siendo obligatorio cuando se envía: no admite vacío', async () => {
      await expect(messagesOf({ name: '' })).resolves.toContain(
        'El nombre del negocio es obligatorio',
      );
    });

    it('un update parcial sin `name` es válido (no se toca)', async () => {
      await expect(errorsOf({ phone_number: '3132531430' })).resolves.toEqual([]);
    });
  });

  describe('whitelist', () => {
    it('rechaza propiedades desconocidas', async () => {
      const errors = await errorsOf({ name: 'X', balance: 999999 });
      expect(errors.flatMap((e) => Object.keys(e.constraints ?? {}))).toContain(
        'whitelistValidation',
      );
    });
  });
});
