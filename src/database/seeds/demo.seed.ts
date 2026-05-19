/**
 * Seed de demo: crea una company de prueba con owner, empleados, categorías,
 * proveedores, productos y clientes. Ejecutado vía `pnpm db:seed`.
 *
 * No es idempotente: si la DB ya contiene el email del owner demo, el script
 * aborta con un mensaje claro pidiendo resetear la base.
 *
 * Bootstrap manual: usa `NestFactory.createApplicationContext` para resolver
 * las inyecciones de los actions del API sin levantar servidor HTTP. Esto
 * garantiza que la lógica de negocio (Big.js, transacciones, hashing argon2,
 * seeds esenciales del owner) se ejecute igual que vía endpoint.
 */
import 'reflect-metadata';

import { ConflictException, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { AppModule } from '@/app.module';
import { RegisterAction } from '@/modules/auth/actions/register.action';
import { CreateCategoryAction } from '@/modules/categories/actions/create-category.action';
import { CreateCustomerAction } from '@/modules/customers/actions/create-customer.action';
import { PersonType } from '@/modules/customers/entities/customer.entity';
import { CreateEmployeeAction } from '@/modules/employees/actions/create-employee.action';
import { EmployeeRole } from '@/modules/employees/entities/employee.entity';
import { CreateProductAction } from '@/modules/products/actions/create-product.action';
import { CreateSupplierAction } from '@/modules/suppliers/actions/create-supplier.action';
import { User } from '@/modules/users/entities/user.entity';

const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? 'owner@demo.pos';
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? 'demoPass123!';
const COMPANY_NAME = process.env.SEED_COMPANY_NAME ?? 'Negocio Demo';

async function bootstrap(): Promise<void> {
  const logger = new Logger('SeedDemo');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const register = app.get(RegisterAction);
    const createCategory = app.get(CreateCategoryAction);
    const createSupplier = app.get(CreateSupplierAction);
    const createProduct = app.get(CreateProductAction);
    const createCustomer = app.get(CreateCustomerAction);
    const createEmployee = app.get(CreateEmployeeAction);
    const dataSource = app.get(DataSource);

    // 1. Owner + Company + seeds esenciales (Wallet "Efectivo",
    //    TicketSettings ORDER/SALE/CN/DN/PURCHASE, AppSettings).
    logger.log(`Registrando owner "${OWNER_EMAIL}" + company "${COMPANY_NAME}"...`);
    try {
      await register.execute({
        name: 'Demo',
        lastname: 'Owner',
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
        company_name: COMPANY_NAME,
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        logger.error(
          `El email "${OWNER_EMAIL}" ya está registrado. ` +
            'Resetea la DB (pnpm migration:revert + run) o cambia SEED_OWNER_EMAIL.',
        );
        throw error;
      }
      throw error;
    }

    // Re-leemos el User para obtener id + company_id (RegisterAction.AuthResponseDto
    // no incluye company_id en el shape de respuesta).
    const ownerUser = await dataSource.getRepository(User).findOneOrFail({
      where: { email: OWNER_EMAIL },
    });
    const companyId = Number(ownerUser.company_id);
    const ownerCreator = {
      id: Number(ownerUser.id),
      fullName: `${ownerUser.name} ${ownerUser.lastname}`.trim(),
    };
    logger.log(`  owner #${ownerCreator.id}, company #${companyId}`);

    // 2. Categorías.
    logger.log('Creando categorías...');
    const categoryNames = ['Bebidas', 'Snacks', 'Limpieza'];
    const categories = await Promise.all(
      categoryNames.map((name) => createCategory.execute({ name }, companyId)),
    );
    categories.forEach((c) => logger.log(`  + categoría #${c.id} "${c.name}"`));

    // 3. Proveedores.
    logger.log('Creando proveedores...');
    const suppliers = await Promise.all([
      createSupplier.execute(
        {
          legal_name: 'Distribuidora Caracas C.A.',
          broker: 'María García',
          phone: '+58 212 5551234',
          doc_number: 'J-12345678-9',
          email: 'ventas@distcaracas.com',
        },
        companyId,
        ownerCreator,
      ),
      createSupplier.execute(
        {
          legal_name: 'Mayorista Andina S.A.',
          broker: 'Carlos Pérez',
          phone: '+58 212 5559876',
          doc_number: 'J-98765432-1',
        },
        companyId,
        ownerCreator,
      ),
    ]);
    suppliers.forEach((s) => logger.log(`  + proveedor #${s.id} "${s.legal_name}"`));

    // 4. Productos (con precios; profit/margin se recalculan en el action).
    logger.log('Creando productos...');
    const productsInput = [
      {
        name: 'Coca-Cola 2L',
        cost: 2.5,
        stock: 50,
        category_id: Number(categories[0].id),
        prices: [{ name: 'Detal', sale_price: 4.5, iva_percentage: 16 }],
      },
      {
        name: 'Pepsi 2L',
        cost: 2.3,
        stock: 30,
        category_id: Number(categories[0].id),
        prices: [{ name: 'Detal', sale_price: 4.2, iva_percentage: 16 }],
      },
      {
        name: 'Doritos Familiar',
        cost: 1.8,
        stock: 25,
        category_id: Number(categories[1].id),
        prices: [{ name: 'Detal', sale_price: 3.5, iva_percentage: 16 }],
      },
      {
        name: 'Detergente Ace 1Kg',
        cost: 3.2,
        stock: 15,
        category_id: Number(categories[2].id),
        prices: [
          { name: 'Detal', sale_price: 5.9, iva_percentage: 16 },
          { name: 'Mayor', sale_price: 5.4, iva_percentage: 16 },
        ],
      },
    ];
    const products = await Promise.all(
      productsInput.map((p) => createProduct.execute(p, companyId, ownerCreator)),
    );
    products.forEach((p) => logger.log(`  + producto #${p.id} "${p.name}"`));

    // 5. Clientes.
    logger.log('Creando clientes...');
    const customers = await Promise.all([
      createCustomer.execute(
        {
          name: 'Juan Pérez',
          person_type: PersonType.INDIVIDUAL,
          phone: '+58 412 1111111',
          doc_number: 'V-12345678',
          email: 'juan@ejemplo.com',
        },
        companyId,
        ownerCreator,
      ),
      createCustomer.execute(
        {
          name: 'Ana Rodríguez',
          person_type: PersonType.INDIVIDUAL,
          phone: '+58 412 2222222',
          doc_number: 'V-87654321',
        },
        companyId,
        ownerCreator,
      ),
      createCustomer.execute(
        {
          name: 'Comercial El Sol C.A.',
          person_type: PersonType.COMPANY,
          phone: '+58 212 9990000',
          doc_number: 'J-55555555-5',
        },
        companyId,
        ownerCreator,
      ),
    ]);
    customers.forEach((c) => logger.log(`  + cliente #${c.id} "${c.name}"`));

    // 6. Empleados (mezcla de roles y login_enabled).
    logger.log('Creando empleados...');
    const employeesInput = [
      {
        name: 'Pedro Manager',
        role: EmployeeRole.MANAGER,
        login_enabled: true,
        username: 'pedro-demo',
        password: 'managerPass1!',
        phone: '+58 412 3333333',
      },
      {
        name: 'Lucía Cajera',
        role: EmployeeRole.EMPLOYEE,
        login_enabled: true,
        username: 'lucia-demo',
        password: 'cashierPass1!',
        phone: '+58 412 4444444',
      },
      {
        name: 'Roberto Reposición',
        role: EmployeeRole.EMPLOYEE,
        login_enabled: false,
      },
    ];
    // Secuencial: cada employee con login crea un User espejo y compite por el
    // mismo email/username único. Paralelo abriría race conditions innecesarias.
    for (const dto of employeesInput) {
      const emp = await createEmployee.execute(dto, companyId, ownerCreator);
      logger.log(`  + empleado #${emp.id} "${emp.name}" (login=${emp.login_enabled})`);
    }

    logger.log('Seed demo completado.');
    logger.log(`Credenciales owner → email: ${OWNER_EMAIL} | password: ${OWNER_PASSWORD}`);
  } finally {
    await app.close();
  }
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[seed:demo] Falló:', error);
  process.exit(1);
});
