# Activación de cuenta por correo

Un owner que se registra **no puede iniciar sesión** hasta confirmar que el
correo es suyo. Antes entraba directo al dashboard.

## El flujo

1. `POST /auth/register` crea company + owner con `users.activated_at = NULL`,
   emite un token de un solo uso y manda el correo de bienvenida.
   **NO devuelve JWT**: devolverlo dejaría entrar justo a quien no ha probado
   nada todavía.
2. El cliente (placepos) reemplaza el formulario por un aviso: "revisa tu
   correo", cuenta atrás de 15 s hacia el login y botón para no esperar.
3. El correo lleva un botón a `<ACTIVATION_BASE_URL>/activar?token=…` — en
   producción, la landing.
4. Esa página canjea el token con `POST /auth/activate` (desde el navegador) y
   muestra el resultado.
5. Al activar se sella `activated_at`, se quema el token y sale el segundo
   correo ("cuenta activada").
6. `POST /auth/user` deja pasar.

Mientras tanto, el login responde **403** con `payload.code =
`ACCOUNT_NOT_ACTIVATED`` y un mensaje que dice exactamente qué hacer.

## Decisiones que conviene no deshacer

- **Se guarda el SHA-256 del token, nunca el token en claro.** Quien lea la
  tabla (un respaldo, un log de consultas, una fuga) no puede activar cuentas
  ajenas. El valor en claro solo existe en el correo del dueño.
- **El token viaja por POST, no por query, hacia el API.** Las URLs quedan en
  logs de acceso, historial y cabecera `Referer`. La página lo lee de su propia
  URL, lo manda en el cuerpo y lo borra de la barra de direcciones.
- **El gate del login es fail-CLOSED** (`if (user.activated_at)`): un SELECT que
  no traiga la columna bloquea, no deja pasar. En una medida de seguridad el
  fallo tiene que ir hacia el lado que cierra.
- **El gate corre DESPUÉS de verificar la contraseña**, igual que el de
  suscripción. Antes filtraría qué correos existen sin conocer la credencial.
- **Un segundo clic en el enlace NO es un error.** Si la cuenta ya está activa
  responde `already_activated: true`: es el caso más común del mundo real
  (doble clic, correo abierto en otro dispositivo) y una pantalla roja ahí
  estaría mintiendo.
- **El token se emite dentro de la transacción del registro**, así no queda un
  enlace huérfano si algo falla después.
- **Reemitir invalida el anterior**: un enlace de activación vivo es una
  credencial, y no tiene sentido tener varias sueltas.

## Quién queda exento

| Caso | Activación | Por qué |
| --- | --- | --- |
| Cuentas anteriores al cambio | Ya activas (backfill de la migración) | Nadie que hoy puede entrar se queda fuera |
| Cuentas creadas desde el panel superadmin | Ya activas (`skipActivation`) | El operador ya validó al cliente; un correo de ida y vuelta solo estorbaría |
| Empleados y usuarios espejo | No aplica | No se registran por este flujo; su alta la hace el owner |

## Probarlo en desarrollo

Hacen falta las dos piezas levantadas, y apuntando la una a la otra:

| Pieza | Puerto | Qué tiene que cumplirse |
| --- | --- | --- |
| `pos_api` | 3010 | `CORS_ORIGINS` incluye `http://localhost:5181` |
| `placepos_lp` | 5181 | En dev llama al API local (`SITE.apiUrl` usa `dev`) |
| `.env` de pos_api | — | `ACTIVATION_BASE_URL=http://localhost:5181` |

El fallo más fácil de cometer es que la landing llame al API de PRODUCCIÓN: los
tokens se emiten contra la base local, así que el enlace saldría siempre
inválido — y, sin el origen de la landing en el CORS de producción, el navegador
ni siquiera dejaría leer la respuesta y la página diría "no pudimos contactar al
servidor". Por eso `SITE.apiUrl` conmuta con el flag `dev` de SvelteKit en vez
de ser una constante.

## Configuración

| Variable | Para qué |
| --- | --- |
| `ACTIVATION_BASE_URL` | Base de la página `/activar`. Vacío = la landing de producción. |
| `CORS_ORIGINS` | **Debe incluir el origen de la landing**: `/auth/activate` se llama desde el navegador. |

El token vive 7 días (`ACTIVATION_TOKEN_TTL_DAYS`).

## Dónde está cada pieza

```
pos_api/
  src/database/migrations/1747012320000-add-account-activation.ts
  src/modules/auth/internal/activation-token.ts      ← lógica pura y testeada
  src/modules/auth/actions/issue-activation-token.action.ts
  src/modules/auth/actions/activate-account.action.ts
  src/modules/auth/actions/login.action.ts           ← el gate
  src/modules/mail/emails/welcome.tsx                ← botón "Activar mi cuenta"
  src/modules/mail/emails/account-activated.tsx
placepos_lp/src/routes/activar/                      ← la página del enlace
placepos/src/renderer/src/modules/Setup/CloudSetup/  ← aviso post-registro
```

## Reenvío desde el panel

El listado de cuentas (`/dashboard/cuentas`) muestra el estado de cada owner y,
cuando hace falta, el botón para reenviar el correo.

| Estado | Qué significa | ¿Botón? |
| --- | --- | --- |
| `active` | Confirmó su correo; puede entrar | No |
| `pending` | Tiene un enlace vigente sin usar | **No** |
| `expired` | El enlace venció sin usarse | Sí |
| `no_link` | No tiene ningún enlace vivo | Sí |

**`pending` no ofrece el botón a propósito.** Reenviar emite un enlace nuevo e
invalida el anterior: si el dueño tiene el correo abierto y está a punto de
pulsarlo, se lo romperíamos.

`POST /superadmin/tenants/:companyId/resend-activation` reemite y reenvía. A
diferencia del resto de correos del sistema, este **espera el envío y falla si
el proveedor lo rechaza** (`ACTIVATION_EMAIL_NOT_SENT`): el operador acaba de
pulsar un botón que dice "reenviar", y darle por bueno un envío que no ocurrió
lo dejaría esperando una respuesta del cliente que nunca va a llegar. Si la
cuenta ya está activa responde 409 sin tocar nada.

Las **sucursales heredan el estado del owner** y nunca ofrecen el botón: la
activación es de la persona, no de cada company.

## Pendiente

No hay reenvío que el propio cliente pueda pedir (`POST /auth/resend-activation`
público, con su límite de tasa). Hoy pasa por el operador o por el WhatsApp de
soporte al que dirige la página de error.
