import Big from 'big.js';

/**
 * Transformer para columnas `numeric` de PostgreSQL.
 *
 * `to`   — JS → DB: convierte cualquier número/string/Big en string (Postgres
 *          recibe `numeric` como texto exacto, sin pérdida de precisión).
 * `from` — DB → JS: convierte el string que pg retorna en `number` para
 *          serialización JSON limpia. **No operes con este `number`**: dentro
 *          del servicio, vuélvelo a `Big` con `toBig(...)` antes de calcular.
 *
 * El driver `pg` ya entrega `numeric` como `string` (no `number`), así que
 * `from` recibe `string | null` en runtime. Aceptamos `unknown` por seguridad
 * en mocks y tests que pueden inyectar otros tipos.
 */
export const NumericTransformer = {
  to(value: Big.BigSource | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    return new Big(value).toString();
  },

  from(value: string | null | undefined): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    return Number(value);
  },
};
