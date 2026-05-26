import { CreateDeliveryCompanyDto } from './create-delivery-company.dto';

/**
 * Payload de `PUT /delivery-companies/:id`. Mismo shape que el de creación
 * (contrato Domiciliarios: el formulario de edición reemplaza name, address y
 * phones por completo). Se mantiene una clase separada para documentación
 * OpenAPI explícita y para poder divergir en el futuro sin tocar el create.
 */
export class UpdateDeliveryCompanyDto extends CreateDeliveryCompanyDto {}
