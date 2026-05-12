import * as argon2 from 'argon2';

/**
 * Parámetros argon2id alineados con OWASP 2024 Password Storage Cheat Sheet
 * (perfil "argon2id m=19456 KiB, t=2, p=1").
 *
 * Centralizados aquí para que TODOS los servicios que hashean o comparan
 * passwords (AuthService, EmployeesService) usen exactamente los mismos
 * costos. Es CRÍTICO que coincidan:
 *
 *   1. El `dummyHash` que computa `AuthService.onModuleInit` se construye con
 *      estas opciones. Para que el path "no existe" tarde lo mismo que
 *      "existe pero password mal" no se puede admitir divergencia.
 *
 *   2. El lookup dual user/employee en `login` corre `argon2.verify` contra
 *      el hash persistido. Si users y employees hashean con parámetros
 *      distintos, el tiempo del `verify` diferiría y un atacante podría
 *      inferir qué entidad existe por timing side-channel.
 *
 *   3. Subir el costo en el futuro implica reemitir hashes (lazy upgrade en
 *      el siguiente login del usuario). Mantener una constante facilita
 *      detectar el upgrade comparando `argon2.needsRehash`.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;
