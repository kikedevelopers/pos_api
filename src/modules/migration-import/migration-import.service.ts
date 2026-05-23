import { Injectable } from '@nestjs/common';

import { ImportZipAction } from './actions/import-zip.action';
import type { MigrationSummaryDto } from './dto/migration-summary.dto';
import type { ParsedZip, SelectableModule } from './internal/manifest.types';

/**
 * Facade del módulo `migration-import`. Sin lógica — delega al action.
 */
@Injectable()
export class MigrationImportService {
  constructor(private readonly importZipAction: ImportZipAction) {}

  importZip(zip: ParsedZip, selectedModules: SelectableModule[]): Promise<MigrationSummaryDto> {
    return this.importZipAction.execute(zip, selectedModules);
  }
}
