import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * FRONTERAS del contexto de préstamos. Préstamos se va a extraer como API
 * aparte: este test falla si alguien vuelve a mezclarlo con el POS.
 *
 *   1. Préstamos solo toca el POS desde `integration/pos/` (los adaptadores).
 *   2. Del núcleo compartido (`@/common`) solo usa lo genérico: decoradores,
 *      tipos, utilidades y el guard de nivel administrador.
 *   3. El POS no importa nada de préstamos; solo `AppModule` lo registra.
 *   4. Los adaptadores se usan únicamente a través de su módulo de integración.
 *   5. Las migraciones de préstamos viven con su contexto, no con las del POS.
 */

const SRC = resolve(__dirname, '..', '..');
const LENDING = resolve(__dirname, '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });

const importsOf = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

/** Resuelve un import a ruta absoluta (alias `@/` o relativo); paquetes → null. */
const resolveImport = (file: string, spec: string): string | null => {
  if (spec.startsWith('@/')) return join(SRC, spec.slice(2));
  if (spec.startsWith('.')) return resolve(file, '..', spec);
  return null;
};

const isInside = (path: string, dir: string): boolean => !relative(dir, path).startsWith('..');

const SHARED_KERNEL = [
  'common/decorators/',
  'common/types/',
  'common/utils/',
  'common/guards/admin-level.guard',
  'common/pos-mode/',
];

const lendingFiles = walk(LENDING).filter((f) => !f.endsWith('boundaries.spec.ts'));
const posFiles = walk(SRC).filter((f) => !isInside(f, LENDING));

describe('Fronteras del contexto de préstamos', () => {
  it('solo los adaptadores de integration/pos importan módulos del POS', () => {
    const offenders = lendingFiles
      .filter((f) => !isInside(f, join(LENDING, 'integration')))
      .flatMap((f) =>
        importsOf(f)
          .map((spec) => resolveImport(f, spec))
          .filter((target): target is string => target !== null && isInside(target, join(SRC, 'modules')))
          .map((target) => `${relative(SRC, f)} → ${relative(SRC, target)}`),
      );
    expect(offenders).toEqual([]);
  });

  it('del núcleo compartido solo usa lo genérico', () => {
    const offenders = lendingFiles.flatMap((f) =>
      importsOf(f)
        .map((spec) => resolveImport(f, spec))
        .filter((target): target is string => target !== null && isInside(target, join(SRC, 'common')))
        .map((target) => relative(SRC, target))
        .filter((target) => !SHARED_KERNEL.some((allowed) => target.startsWith(allowed)))
        .map((target) => `${relative(SRC, f)} → ${target}`),
    );
    expect(offenders).toEqual([]);
  });

  it('el POS no importa nada de préstamos (salvo AppModule, que lo registra)', () => {
    const offenders = posFiles
      .filter((f) => relative(SRC, f) !== 'app.module.ts')
      .flatMap((f) =>
        importsOf(f)
          .map((spec) => resolveImport(f, spec))
          .filter((target): target is string => target !== null && isInside(target, LENDING))
          .map((target) => `${relative(SRC, f)} → ${relative(SRC, target)}`),
      );
    expect(offenders).toEqual([]);
  });

  it('AppModule solo conoce el punto de entrada LendingModule', () => {
    const targets = importsOf(join(SRC, 'app.module.ts'))
      .map((spec) => resolveImport(join(SRC, 'app.module.ts'), spec))
      .filter((target): target is string => target !== null && isInside(target, LENDING))
      .map((target) => relative(SRC, target));
    expect(targets).toEqual(['lending/lending.module']);
  });

  it('los adaptadores solo se usan a través del módulo de integración', () => {
    const adapters = join(LENDING, 'integration', 'pos');
    const offenders = lendingFiles
      .filter((f) => !isInside(f, adapters))
      .flatMap((f) =>
        importsOf(f)
          .map((spec) => resolveImport(f, spec))
          .filter((target): target is string => target !== null && isInside(target, adapters))
          .filter((target) => !target.endsWith('pos-lending-integration.module'))
          .map((target) => `${relative(SRC, f)} → ${relative(SRC, target)}`),
      );
    expect(offenders).toEqual([]);
  });

  it('las migraciones de préstamos no están en la carpeta del POS', () => {
    // OJO: el POS tiene su propio "préstamo de mercancía" (ticket_type LOAN);
    // esas migraciones son del POS. Aquí se buscan las tablas y conceptos de
    // ESTE contexto. `add-lender-pos-mode` SÍ es del núcleo: el tipo de
    // negocio es un atributo del tenant que administra el panel superadmin.
    const posMigrations = readdirSync(join(SRC, 'database', 'migrations')).filter((name) =>
      /loan-plans|create-loans|loan-disbursement/i.test(name),
    );
    expect(posMigrations).toEqual([]);
  });
});
