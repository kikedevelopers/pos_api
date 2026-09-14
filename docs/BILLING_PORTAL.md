# Portal de facturación (landing)

> Endpoints `/portal/*` — **cloud-only**. Los consume `placepos_lp` (la landing)
> desde el navegador. No existen en el modo servidor local de PlacePos.

## Por qué existe

El registro y el login de la app ya funcionaban, pero dejaban un hueco: **quien
tiene la suscripción vencida no puede iniciar sesión** (`LoginAction` responde
402), y es exactamente la persona que necesita entrar a pagar. Además la
suscripción no sabía distinguir "se acabó la prueba" de "el pago rebotó", así
que no había forma de decirle al dueño qué le pasó.

El portal resuelve las dos cosas con la superficie mínima: entrar, verse y
elegir plan. Nada de datos del negocio.

## Modelo

`subscriptions` gana cuatro columnas (migración `1747012400000`):

| Columna | Qué es |
|---|---|
| `plan` | Plan vigente: `free` \| `monthly` \| `annual`. `free` es la prueba. |
| `status` | Estado del **cobro**: `trialing` \| `active` \| `payment_pending` \| `payment_failed` \| `canceled`. |
| `requested_plan` | Plan pedido y **sin pagar**. `null` si no hay nada pendiente. |
| `plan_requested_at` | Cuándo se pidió. |

Dos reglas que no se negocian:

1. **`expires_at` sigue siendo la única fuente de la verdad del bloqueo.**
   `status` explica *por qué*, nunca *hasta cuándo*. Dos datos que puedan
   contradecirse sobre lo mismo es la forma garantizada de bloquear a quien
   pagó.
2. **Pedir un plan no es tenerlo.** `POST /portal/subscription/plan` NUNCA
   escribe `plan` ni `expires_at` (ver `internal/plan-transition.ts` y sus
   tests). Solo un pago confirmado promueve `requested_plan` a `plan`.

El estado que se le muestra al usuario se calcula cruzando ambos en
`subscriptions/internal/subscription-state.ts` (`resolveEffectiveStatus`), que
añade el valor derivado `expired`. `GET /subscription` y el portal sirven ya ese
valor cruzado, para que ningún cliente lo reimplemente a su manera.

## Endpoints

| Método | Ruta | Quién | Qué |
|---|---|---|---|
| `POST` | `/portal/auth/login` | público (10/min) | Login del portal. |
| `GET` | `/portal/account` | owner | Cuenta + negocio + suscripción. |
| `POST` | `/portal/subscription/plan` | owner | Pide un plan (`free`/`monthly`/`annual`). |

El **registro** NO tiene endpoint propio: la landing llama al mismo
`POST /auth/register` que la app de escritorio, con su mismo correo de
bienvenida y su misma activación (ver `ACCOUNT_ACTIVATION.md`). Una cuenta creada
desde la web es la misma cuenta, sin ninguna variante.

### El login del portal, en tres diferencias

Frente a `POST /auth/user`:

1. **No bloquea por suscripción vencida** — es el punto entero del portal.
2. **Solo dueños** (`type = owner`). Un empleado recibe `PORTAL_OWNER_ONLY` con
   un mensaje que le dice a dónde ir; el superadmin también queda fuera (no
   tiene company ni plan que gestionar).
3. **Emite un token acotado**: `scope: 'portal'` en el JWT, TTL
   `JWT_EXPIRES_PORTAL` (12 h por defecto).

Todo lo demás es idéntico y **reutiliza las mismas piezas** (`argon2` con el
mismo hash, `DummyHashService` anti-timing, `JwtIssuerService`, exigencia de
cuenta activada). Dos implementaciones de "¿esta contraseña es correcta?" se
desincronizan, y la que se queda corta es la que abre la puerta.

### El alcance del token

`PortalScopeGuard` (APP_GUARD, justo después de `JwtAuthGuard` y **antes** de
`SubscriptionGuard`) rechaza con 403 `PORTAL_TOKEN_SCOPE` cualquier token
`portal` fuera de una ruta `@PortalRoute()`.

Sin ese guard, dejar entrar con la suscripción vencida convertiría el
vencimiento en la manera de conseguir un token que abre todo el API sin pagar:
el bloqueo, transformado en su propio bypass. La lista de rutas permitidas es
explícita, así que un endpoint nuevo queda cerrado por omisión, nunca abierto.

Los tokens `app` (los de siempre) no llevan el claim y no cambian en nada.

## Códigos de error

| Código | Status | Cuándo |
|---|---|---|
| `ACCOUNT_NOT_ACTIVATED` | 403 | La cuenta no ha canjeado el enlace del correo. |
| `PORTAL_OWNER_ONLY` | 403 | No es el dueño (empleado, superadmin, o no es el titular de la suscripción). |
| `PORTAL_TOKEN_SCOPE` | 403 | Token de portal usado fuera de `/portal/*`. |
| `EMAIL_TAKEN` | 409 | Registro con un correo que ya tiene cuenta. |

## Lo que falta (pasarela)

No hay cobro automático todavía. Hoy `POST /portal/subscription/plan` deja la
solicitud en `payment_pending` y el cobro se completa por fuera. Cuando entre la
pasarela, encaja sin tocar este modelo:

- Webhook de pago confirmado → `plan = requested_plan`, `requested_plan = null`,
  `status = 'active'`, `expires_at` extendido según el plan.
- Pago rechazado → `status = 'payment_failed'` (el portal ya sabe pintarlo).

## CORS

El origen de la landing (`https://placepos.kikedevs.com`, y `localhost:5181` en
desarrollo) debe estar en `CORS_ORIGINS`: todas estas llamadas salen del
navegador. Sin él, la landing deja de poder crear cuentas.
