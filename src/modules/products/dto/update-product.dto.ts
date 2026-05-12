import { PartialType } from '@nestjs/swagger';

import { CreateProductDto } from './create-product.dto';

/**
 * Payload de `PUT /inventory/:id`.
 *
 * `PartialType` permite que el cliente envíe sólo los campos a actualizar.
 * Sin embargo, **si envía `prices`, el array debe ser COMPLETO** — el
 * service compara contra los precios existentes y borra los que no estén
 * en el array (espejo PlacePos). Esta semántica se documenta aquí porque
 * `PartialType` no puede expresarla.
 */
export class UpdateProductDto extends PartialType(CreateProductDto) {}
