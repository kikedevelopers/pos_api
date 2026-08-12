# Recuperación de contraseña

Desde el inicio de sesión de placepos (solo modo cloud): **¿Olvidaste tu
contraseña?** → correo → la app se abre sola en la pantalla de contraseña nueva.

## El flujo

1. `POST /auth/forgot-password` con el correo. Valida que la cuenta **exista** y
   esté **activada**, emite un token de un solo uso (2 h) y manda el correo.
2. El botón del correo apunta a `<ACTIVATION_BASE_URL>/restablecer?token=…`
   (la landing), **no** a `placepos://` directamente.
3. Esa página lanza `placepos://reset-password?token=…`, que abre PlacePos —
   arrancándolo si estaba cerrado.
4. El renderer navega a `/reset-password`, con las mismas reglas de contraseña
   del registro y validación en vivo.
5. `POST /auth/reset-password` cambia la contraseña, quema el token y dispara el
   correo de confirmación.

## Decisiones que conviene no deshacer

- **El correo NO enlaza `placepos://` directamente.** Buena parte de los
  clientes de correo se niegan a abrir esquemas propios y el botón no haría
  nada. La página HTTPS de la landing es la que lanza la app, y además puede
  explicar qué hacer si no pasa nada.
- **El token va por POST y se borra de la barra de direcciones.** Las URLs
  quedan en logs, historial y cabecera `Referer`, y este token permite tomar el
  control de la cuenta.
- **Vive 2 horas**, frente a los 7 días del de activación: quien pide recuperar
  su contraseña está delante del computador en ese momento.
- **Se guarda el SHA-256**, nunca el valor en claro. Mismo mecanismo que la
  activación (`internal/one-time-token.ts`, compartido).
- **Las reglas de contraseña se aplican en el SERVIDOR**
  (`internal/password-policy.ts`), no solo en el formulario: una validación que
  solo vive en el cliente es una sugerencia. El error dice qué falta, no
  "contraseña inválida".
- **El aviso de cambio no lleva botón**: no es una felicitación, es la alarma de
  quien NO hizo el cambio. Quien sí lo hizo ya está dentro.
- **`forgot-password` falla si el correo no salió** en vez de decir "revisa tu
  bandeja": lo contrario deja a la persona esperando algo que no va a llegar.

## Enumeración de cuentas (decisión consciente)

`forgot-password` distingue "no existe" de "sin activar" **a propósito**, para
que el usuario sepa qué le pasa. El precio: cualquiera puede averiguar si una
dirección está registrada. Lo acota el `ThrottlerGuard` global. Si algún día
pesa más la privacidad, basta con responder siempre `sent: true` sin distinguir
— el resto del flujo no cambia.

## Deep link `placepos://`

Tres caminos, y hacen falta los tres (`src/main/deepLink.ts` en placepos):

| Sistema | App abierta | App cerrada |
| --- | --- | --- |
| macOS | evento `open-url` | evento `open-url` |
| Windows/Linux | `second-instance` (URL en el argv del proceso que no arrancó) | `process.argv` del arranque |

Cuando el enlace llega antes de que exista el renderer, main lo guarda y el
renderer lo reclama al montar (`deep-link:consume-pending`). Sin eso se perdería
justo el caso más habitual: alguien que pulsa el botón sin tener la app abierta.

Registro del esquema: `setAsDefaultProtocolClient` en tiempo de ejecución,
`CFBundleURLTypes` en el `Info.plist` de macOS y `mimeTypes` en el `.desktop` de
Linux. En la app empaquetada de macOS manda el bundle, no la llamada.

Solo se enrutan los destinos declarados en `ROUTE_BY_HOST`: un
`placepos://loquesea` no puede convertirse en navegación interna.

### Probarlo en DESARROLLO (macOS)

En macOS quien decide qué app abre un esquema es LaunchServices, y lo lee del
`Info.plist` del bundle. En desarrollo el bundle es el `Electron.app` de
`node_modules`, que no declara nada: `setAsDefaultProtocolClient()` no tiene
efecto y **el enlace no abre nada**. Una vez:

```bash
cd placepos && pnpm deeplink:register-dev
open "placepos://reset-password?token=abc123"   # comprobación
```

Vive dentro de `node_modules`, así que se pierde al reinstalar dependencias. En
la app EMPAQUETADA no hace falta: lo declara `CFBundleURLTypes`.

### La página nunca usa `location.href` para el esquema

Si el sistema no tiene registrado `placepos://`, el navegador falla con
`ERR_UNKNOWN_URL_SCHEME` y **descarta la página**: el usuario se queda con una
pestaña en blanco y sin ninguna explicación. Por eso `/restablecer` lanza el
enlace con un iframe oculto, que falla en silencio y deja la página en pie para
poder contarle qué pasó.

## Dónde está cada pieza

```
pos_api/
  src/database/migrations/1747012340000-add-password-reset-tokens.ts
  src/modules/auth/internal/one-time-token.ts      ← mecanismo compartido
  src/modules/auth/internal/password-reset-token.ts
  src/modules/auth/internal/password-policy.ts     ← las 4 reglas
  src/modules/auth/actions/request-password-reset.action.ts
  src/modules/auth/actions/reset-password.action.ts
  src/modules/mail/emails/password-reset.tsx
  src/modules/mail/emails/password-changed.tsx
placepos_lp/src/routes/restablecer/                ← puente hacia la app
placepos/
  src/main/deepLink.ts                             ← los tres caminos
  src/renderer/src/hooks/useDeepLinkNavigation.ts
  src/renderer/src/modules/PasswordRecovery/
```

## Pendiente

El cambio de contraseña **no invalida las sesiones abiertas**: un JWT emitido
antes sigue siendo válido hasta que caduque (7 días para owners). Para el caso
"me robaron la cuenta" habría que añadir un `password_changed_at` que el
`JwtAuthGuard` compare contra el `iat` del token.
