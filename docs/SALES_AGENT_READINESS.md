# Madurez del agente vendedor (diagnóstico del 31-oct-2026)

Pregunta: ¿el agente está listo para atender y cerrar ventas solo, con publicidad
paga en redes?

**Veredicto: todavía no.** Está listo para un **piloto supervisado** con clientes
reales. Lo que ya hace está bien hecho; lo que falta es sobre todo cómo se
comporta con muchos clientes reales a la vez.

## Lo que ya está maduro

- Exactitud del pedido validada en el SERVIDOR (no solo en el prompt): unidades
  enteras, pedido por valor (`amount-request.ts`) y por peso (`weight-request.ts`).
- Ciclo completo: buscar, cotizar, carrito, datos de entrega y pago, confirmar,
  cerrar; después el cliente puede modificar o cancelar.
- Memoria persistente (`sales_bot_conversations`), sin saludos repetidos, notas
  de voz transcritas.
- Controles: anti-troll (`off-topic.ts`), créditos de IA por negocio, pausa
  cuando responde un humano (`sales_bot_takeovers`).
- Avisos al dueño: bandeja Informes → Agente, campana, push y WhatsApp.
- 25 archivos de tests en `src/modules/sales-agent/__tests__`.

## Bloqueantes antes de pagar publicidad

1. **Canal no oficial.** WhatsApp por QR (Baileys) en el escritorio: riesgo de
   baneo con picos de chats nuevos y depende de que el PC esté prendido con
   PlacePOS abierto. Hace falta la Cloud API oficial con **Embedded Signup**.
   El canal Cloud API existe (`channels/whatsapp`) pero le faltan notas de voz y
   la pausa por toma humana.
2. **Un cliente a la vez.** La cola del escritorio
   (`placepos/src/main/services/whatsapp/index.ts`, `processRelayQueue`) procesa
   TODOS los chats en serie; con más de 100 mensajes en cola, descarta sin aviso.
   Debe ser en paralelo entre chats y en orden dentro de cada chat.
3. **No agrupa mensajes seguidos.** «hola» + «tienes maní?» + «y uva pasa?» =
   tres respuestas separadas. Falta un debounce por chat que junte la ráfaga.
4. **Fotos, comprobantes y ubicaciones se ignoran en silencio.** El escritorio
   solo pasa texto y audio (`extractIncomingMessage`).
5. **Exactitud sin probar en producción.** La última conversación local fue el
   error «1 @ de maní» → «media libra $4.300»; el fix `840a681` falta desplegarlo
   y re-probarlo. Modelo flash-lite con `SALES_BOT_TEMPERATURE` 0.8: bajar a
   0.3–0.4.
6. **Sin costo de domicilio ni zonas de cobertura.** El total no incluye el envío
   y el agente promete domicilio sin saber si llega.
7. **Sin horario de atención.** No responde «¿a qué hora abren?» y de noche
   cierra pedidos sin aclarar que se atienden al día siguiente.
8. **Sin escalar a una persona.** Falta una salida para «quiero hablar con
   alguien», reclamos o pedidos especiales.

## No bloquea, pero hay que tenerlo claro

- Cierra el PEDIDO, no la venta: no verifica pagos ni descuenta stock. El equipo
  debe tomar cada pedido rápido (en la prueba, 3 de 6 seguían pendientes).
- No reserva stock: dos clientes pueden comprar la última unidad.
- Si le preguntan en serio si es un bot, el prompt le ordena negarlo y lo trata
  como fuera de tema. Mejor que lo admita con naturalidad y siga vendiendo
  (confianza y políticas de WhatsApp).
- Sin seguimiento de carritos abandonados dentro de la ventana de 24 h.

## Evidencia real

BD local al 31-oct-2026: 1 conversación, 6 pedidos y 38 llamadas a la IA, todo
de pruebas del mismo día. No alcanza para medir el comportamiento con muchos
clientes.

## Plan recomendado

1. Corregir los puntos 3 a 8, desplegar y re-probar el pedido por peso.
2. Piloto de 1–2 semanas con clientes reales que ya escriben, sin publicidad y
   revisando cada pedido. Medir pedidos correctos, tiempo de respuesta y
   conversaciones abandonadas.
3. Antes de la publicidad: Cloud API oficial con Embedded Signup y chats en
   paralelo (puntos 1 y 2).
4. Publicidad con presupuesto bajo; escalar según los números del piloto.
