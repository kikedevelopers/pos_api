import type { ZipTableName } from './manifest.types';

/**
 * Mantiene mapas `idLocalDelZip → idRealDeBd` por tabla. Los IDs en el ZIP
 * son strings sintéticos ("1", "2", ...) emitidos por el migrador. Aquí los
 * traducimos a los ids autoincrementales reales que PostgreSQL devuelve al
 * INSERT.
 *
 * No es multi-tenant: una instancia por import, descartada al final.
 */
export class IdRemapper {
  private readonly maps = new Map<ZipTableName, Map<string, string>>();

  /**
   * Registra el mapeo `localId → dbId` para una tabla. Si ya existía, lanza
   * — un mismo id local no debe insertarse dos veces.
   */
  set(table: ZipTableName, localId: string, dbId: string): void {
    let m = this.maps.get(table);
    if (!m) {
      m = new Map<string, string>();
      this.maps.set(table, m);
    }
    if (m.has(localId)) {
      throw new Error(`IdRemapper: localId duplicado ${table}/${localId}`);
    }
    m.set(localId, dbId);
  }

  /**
   * Lookup obligatorio. Lanza si no encuentra el mapping — el caller debe
   * verificar nulabilidad antes si la FK es nullable.
   */
  get(table: ZipTableName, localId: string): string {
    const m = this.maps.get(table);
    const found = m?.get(localId);
    if (!found) {
      throw new Error(`IdRemapper: lookup fallido ${table}/${localId}`);
    }
    return found;
  }

  /**
   * Lookup tolerante: devuelve null si el id local no existe o el input es
   * nullable. Útil para FKs opcionales (customer_id, packaging_id, etc.).
   */
  getOptional(table: ZipTableName, localId: string | null | undefined): string | null {
    if (localId === null || localId === undefined) {
      return null;
    }
    const m = this.maps.get(table);
    return m?.get(localId) ?? null;
  }

  /**
   * Indica si la tabla tiene al menos un mapping registrado.
   */
  has(table: ZipTableName, localId: string): boolean {
    return this.maps.get(table)?.has(localId) ?? false;
  }
}
