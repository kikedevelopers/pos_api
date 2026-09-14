# Módulo de correo (`src/modules/mail`)

Único camino por el que salen correos de pos_api. Está construido para que
**cambiar de proveedor cueste un archivo y una línea**.

## Cómo está armado

```
src/config/mail.config.ts          ← credenciales y elección del driver
src/modules/mail/
  drivers/
    mail-driver.interface.ts       ← EL CONTRATO (send + verify + isConfigured)
    mail-driver.factory.ts         ← el único switch que decide el proveedor
    resend.driver.ts               ← producción
    smtp.driver.ts                 ← desarrollo (Mailtrap) y cualquier SMTP
    log.driver.ts                  ← sin credenciales: escribe el correo en el log
  emails/                          ← PLANTILLAS en React Email (.tsx)
    components/theme.ts            ← tokens de marca (los mismos de la landing)
    components/EmailLayout.tsx     ← shell común: logo, filo de marca, tarjeta, pie
    welcome.tsx                    ← correo de bienvenida
  internal/                        ← piezas puras y testeadas (direcciones, errores, estado)
  templates/
    render.ts                      ← React Email → { subject, html, text }
    template-catalog.ts            ← catálogo + datos de muestra
  mail.service.ts                  ← API pública: lo ÚNICO que usa el resto de la app
  mail.controller.ts               ← /admin/mail/* (firmados)
```

La regla que sostiene todo: **nadie fuera de `drivers/` sabe qué proveedor hay
detrás**. `MailService` habla con la interfaz; las plantillas devuelven HTML y
texto; los módulos de dominio solo inyectan `MailService`.

## Plantillas (React Email)

Las plantillas se escriben como componentes React en `emails/` y se renderizan a
HTML + texto plano con `renderEmail`. El texto plano sale del MISMO árbol, así
que nunca se desincroniza del HTML — que es lo que pasa cuando se escribe a mano.

**Verlas mientras las construyes:**

```bash
pnpm email:dev      # http://localhost:3030
```

Recarga en caliente y usa los datos de `Component.PreviewProps`.

### Diseño

Tema OSCURO, con los tokens de la landing (`placepos_lp/src/lib/styles/app.css`):
lienzo `#07070b`, tarjeta `#11111c`, borde `#23233a` y el acento de marca
violeta → azul → cian. Reglas que hay que respetar al añadir un correo:

- **Estilos en línea, y maquetación con tablas** (`Row`/`Column`). Gmail y
  Outlook descartan `<style>`, `flex`, `grid` y las variables CSS.
- **Todo degradado lleva su `backgroundColor` sólido al lado.** Outlook ignora
  `background-image`; sin el sólido, el elemento se ve transparente.
- **`color-scheme: dark` en el `<Head>`** (ya lo pone `EmailLayout`). Sin él, el
  modo oscuro de Gmail/Outlook reinvierte los colores por su cuenta.
- **El logo es una URL pública absoluta** (`MAIL_LOGO_URL`, por defecto
  `<MAIL_ASSETS_BASE_URL>/logo.png`). Gmail descarta las `data:` URIs. Y como
  muchos clientes bloquean imágenes, el membrete NO puede depender de ella: el
  nombre va en texto al lado y la imagen es decorativa (`alt=""`), para que un
  logo bloqueado no pinte un cuadro roto con texto cortado.
  **Pendiente:** `placepos_lp/static/logo-email.png` (160 px, ~30 KB) ya está en
  el repo de la landing; cuando se despliegue, cambiar el default por él — el
  `logo.png` actual pesa 541 KB.
- **Nunca invitar a responder.** El remitente es `no-reply@`: quien conteste le
  escribe a un buzón que no lee nadie. Si un correo necesita ofrecer soporte,
  tiene que enlazar un canal real (el WhatsApp que publica la landing). Un test
  recorre todo el catálogo para que ninguna plantilla vuelva a prometerlo.
- **Un solo botón por correo.** Dos llamados a la acción compiten y ninguno gana.
- **`Preview`** siempre: es la línea que se lee en el buzón antes de abrir.

### Añadir una plantilla

1. Crear `emails/<nombre>.tsx` usando `EmailLayout` y exportar `PreviewProps`.
2. Sumar su id a `EmailTemplateId`, su entrada a `EMAIL_TEMPLATES` y su rama a
   `renderSampleEmail` (`template-catalog.ts`). El `never` del `default` rompe
   el build si se olvida.
3. El panel kdevs-admin la lista sola: sale de `GET /admin/mail/templates`.

## Enviar un correo desde otro módulo

`MailModule` es `@Global()`, así que no hay que importarlo:

```ts
constructor(private readonly mailService: MailService) {}

await this.mailService.send({
  to: user.email,          // string o string[]; se normaliza y valida
  subject: '…',
  html: '…',               // normalmente, el resultado de renderEmail(...)
  text: '…',               // obligatorio: sin él los filtros de spam castigan
});
```

Lanza `BadRequestException` si el destinatario no sirve y `MailDeliveryError`
(con `message` ya en español y `retriable`) si el proveedor rechaza el envío.
Los fallos transitorios se reintentan UNA vez solos.

## Cambiar de proveedor (p. ej. Resend → SendGrid)

1. **Copia `resend.driver.ts`** a `sendgrid.driver.ts` y ajusta `send()` y
   `verify()` al API del nuevo proveedor. Son ~120 líneas y la mayoría es
   traducción de errores.
2. **Añade sus credenciales** en `src/config/mail.config.ts` (bloque nuevo en
   `MailConfig` + lectura del entorno), su valor en `MailDriverName`, y las
   variables en `.env.example` y `src/config/validation.schema.ts`.
3. **Añade el `case`** en `createMailDriver` (`mail-driver.factory.ts`).

Eso es todo. `MailService`, las plantillas, los controladores y cualquier módulo
que envíe correos quedan intactos. Si olvidas el paso 3, TypeScript rompe el
build en el `never` del `default` — no hay forma de dejarlo a medias en silencio.

## Configuración

| Variable | Para qué |
| --- | --- |
| `MAIL_DRIVER` | `resend` \| `smtp` \| `log`. Vacío = se resuelve solo (ver abajo). |
| `MAIL_FROM` | Remitente. **Su dominio debe estar verificado en el proveedor.** |
| `MAIL_REPLY_TO` | Responder-a por defecto. Vacío = no se manda la cabecera. |
| `MAIL_TIMEOUT_MS` | Corte de cada envío y de la verificación. |
| `RESEND_API_KEY` | Llave de Resend (basta el permiso "Sending access"). |
| `SMTP_HOST/PORT/USERNAME/PASSWORD/SECURE` | SMTP genérico (Mailtrap en dev). |
| `MAIL_ASSETS_BASE_URL` | Base pública de los assets del correo. Por defecto, la landing. |
| `MAIL_LOGO_URL` | URL exacta del logo. Vacío = `<assets>/logo-email.png`. |

Con `MAIL_DRIVER` vacío la cascada es: hay llave de Resend → `resend`; hay host
SMTP → `smtp`; si no → `log`. Por eso un clon recién bajado, sin credenciales,
arranca y funciona: los correos van al log en vez de reventar el flujo.

`SMTP_SECURE` vacío deduce del puerto (465 → TLS implícito, resto → STARTTLS).

## Estado y prueba (panel kdevs-admin)

- `GET /admin/mail/status` — verifica credenciales **sin enviar nada** y añade la
  actividad real de envíos del proceso (enviados, fallidos, último error).
- `GET /admin/mail/templates` — catálogo de plantillas (sale del código).
- `POST /admin/mail/test` — `{ "to": "…", "template"?: "welcome" }`. Con
  `template` manda esa plantilla con datos de muestra, renderizada por el mismo
  código que usa producción; sin él, el correo de diagnóstico simple.

La sección **Correos** del panel (`/dashboard/correos`) junta las tres cosas:
estado, catálogo y un único campo de destinatario para probar cualquiera.

Ambos van firmados con Ed25519 (`AdminSignatureGuard`). **Ese guard reconstruye
el mensaje canónico con el hash del cuerpo VACÍO**, así que el cliente debe
firmar `sha256('')` también en el POST (en kdevs-admin es la opción
`signEmptyBody` de `signedFetch`). Firmar el cuerpo real da 401.

### El semáforo (`level`)

| Nivel | Cuándo |
| --- | --- |
| `disabled` | Sin credenciales: no se puede enviar nada. |
| `warning` | Driver `log` (no sale ningún correo) o fallos anteriores ya superados. |
| `error` | El proveedor no responde bien **o** los últimos envíos están fallando. |
| `ok` | Credenciales válidas y sin fallos pendientes. |

La segunda mitad de `error` es la importante: las credenciales pueden estar
perfectas y aun así no llegar ni un correo (dominio sin verificar, límite del
plan). `verify()` solo no lo detecta; el contador de fallos consecutivos sí.

Un destinatario mal escrito **no** cuenta como fallo: es un error de quien llama,
no del servidor de correos, y pintarlo de rojo sería mentir sobre el estado.

## Correos que envía la app

| Correo | Cuándo | Dónde se dispara |
| --- | --- | --- |
| Bienvenida (activar cuenta) | Al registrarse un owner | `RegisterAction`, vía `SendWelcomeEmailAction` |
| Cuenta activada | Al canjear el enlace | `ActivateAccountAction`, vía `SendAccountActivatedEmailAction` |

Ambas actions **nunca lanzan** y se disparan sin `await`: el correo no puede
alargar el registro ni la activación, ni tumbarlos si el proveedor falla. Un
fallo queda en el log y en el contador de `/admin/mail/status`, que es donde
toca mirarlo.

El flujo completo de activación está en [`ACCOUNT_ACTIVATION.md`](./ACCOUNT_ACTIVATION.md).

## Notas de operación

- El estado vive en memoria y se reinicia con el proceso: siempre refleja el
  despliegue vigente, no la historia.
- Mailtrap **sandbox** atrapa todos los correos y no entrega ninguno de verdad:
  es lo correcto en desarrollo.
- Con una llave de Resend de solo envío, `verify()` no puede listar dominios y
  el proveedor responde "restricted". Eso se trata como **válida**, no como
  caída: lo contrario dejaría el panel en rojo permanente con todo bien.
- Los tests corren con `--experimental-vm-modules` (ya está en el script
  `test`): `@react-email/render` carga `react-dom/server` con un `import()`
  dinámico que Jest en CJS rechaza sin esa flag.
