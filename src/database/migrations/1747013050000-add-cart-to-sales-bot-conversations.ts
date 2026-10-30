import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — CARRITO vivo por conversación.
 *
 * El vendedor arma el pedido línea a línea (`set_cart_item`) con precios que
 * calcula el SERVIDOR (no el modelo), junto con los datos de entrega
 * (`set_order_details`). Al confirmar, `place_order` crea el PEDIDO real (ORDER)
 * en el POS. `cart` es NULL mientras no haya nada en curso.
 */
export class AddCartToSalesBotConversations1747013050000 implements MigrationInterface {
  name = 'AddCartToSalesBotConversations1747013050000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_bot_conversations"
        ADD COLUMN IF NOT EXISTS "cart" jsonb NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_bot_conversations" DROP COLUMN IF EXISTS "cart"
    `);
  }
}
