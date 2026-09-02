# Imágenes de items del inventario

Una imagen por item — producto base, presentación y combo — guardada en Google
Cloud Storage. Cloud-only: el servidor local de PlacePos (modo LAN) no tiene
bucket ni columna, y el formulario simplemente no muestra el campo.

## Por qué está armado así

### La columna guarda la RUTA, no la URL

`products.image` contiene la ruta del objeto en el bucket:

```
inventory_items/<company_id>/<product_id>-<aleatorio>.<ext>
```

La URL con la que el navegador ve la imagen se **firma al leer** y caduca, así
que persistirla sería guardar un dato con fecha de vencimiento. Las tres piezas
de la ruta responden a un problema concreto:

- **Carpeta por company** — al mirar el bucket se ve de quién es cada archivo, y
  borrar todo lo de un tenant es un prefijo, no una lista de rutas. Antes de
  borrar cualquier objeto se comprueba que la ruta pertenezca a la carpeta de esa
  company (`isObjectOwnedByCompany`): un dump mal importado no puede hacer que un
  negocio borre el archivo de otro.
- **`product_id` al frente** — buscar la imagen de un producto en la consola de
  GCS es teclear el id, sin cruzar contra la base.
- **Sufijo aleatorio** — al reemplazar la foto la ruta cambia, así que ni el
  navegador ni ningún CDN pueden servir la anterior desde su caché. La vieja se
  borra en el mismo flujo, así que no se acumulan.

### El caché de URLs firmadas existe por la cuota, no por la latencia

En producción el API se autentica con la identidad de la VM (ADC). Con ADC,
firmar una URL **no es una operación local**: Google la resuelve con una llamada
a `iam.signBlob`, que tiene cuota. Sin caché, cada refresco del inventario o del
POS dispararía una firma **por producto** y la cuota se agotaría en minutos.

`ProductImageUrlCache` (node-cache, en memoria) guarda `ruta → URL firmada`
durante 6 h, y la firma vale 24 h. El TTL del caché se recorta solo a la mitad de
la vigencia de la firma: si duraran lo mismo, el último cliente en recibir una
URL cacheada se llevaría un enlace a punto de caducar y vería la imagen rota.

La clave es la ruta y no el id del producto, así que una entrada obsoleta nunca
puede devolver la URL de una imagen que ya no existe. Aun así se invalida
explícitamente al reemplazar, quitar y purgar.

Es un caché **por instancia**. Con un solo contenedor —el despliegue actual—
alcanza; con varias réplicas cada una firmaría una vez y ya.

El caché nace vacío en cada despliegue, así que la primera apertura de la app
tras un release firma el catálogo entero dentro del request. Por eso las firmas
que faltan se piden de 24 en 24 (`SIGN_CONCURRENCY`): con lotes de 8, un
catálogo de 500 fotos serían ~63 vueltas de red en serie contra `iam.signBlob`.

### Reemplazar: subir primero, borrar después

```
1. validar producto y archivo   (antes de gastar una llamada a GCS)
2. subir el objeto NUEVO         (ruta nueva)
3. apuntar la fila al nuevo
4. borrar el ANTERIOR
```

Si falla el 2 o el 3, el producto conserva su imagen vieja intacta. El orden
inverso —borrar primero— dejaría al producto sin ninguna imagen ante el primer
fallo de red. El precio es que un fallo en el paso 4 deja un huérfano en el
bucket: basura barata frente a que el usuario vea desaparecer su foto.

### Firmar es dar acceso: solo se firman rutas propias

`resolveUrls` recibe la company y descarta cualquier ruta que no viva en su
carpeta. `products.image` la escribe solo el servidor, pero hay dos caminos que
podrían meter una ruta ajena: el import de un respaldo de OTRA empresa
(`superadmin/import-tenant`) y la migración offline→cloud
(`migration-import`). Ambos anulan ahora la columna al importar
(`BUCKET_PATH_COLUMNS`), y el filtro al firmar es el segundo cinturón — el mismo
que ya existía para borrar y purgar.

### Los borrados DUROS también limpian el bucket

La purga diferida cubre "archivar". Cuando las filas desaparecen de verdad, la
única referencia al archivo se va con ellas:

- **Eliminar un tenant** (`delete-tenant`): se borra la carpeta completa
  `inventory_items/<company_id>/` de cada company afectada (principal y sus
  sucursales), después del commit.
- **Vaciar el inventario** (`clear-tenant-inventory`): las rutas de los productos
  que se van a borrar se leen ANTES del DELETE y se eliminan tras el commit; los
  productos protegidos solo se archivan, así que su imagen entra en la cuenta
  regresiva normal (antes esa vía archivaba sin programar purga).
- **Importar un respaldo sobre otra company** (`superadmin/import-tenant`): los
  productos del DESTINO se borran para dar paso a los del origen, así que su
  carpeta se limpia entera. Los del origen llegan sin imagen.
- **Re-migrar un negocio ya migrado** (`migration-import`): la re-corrida borra
  sus productos y reinserta desde el ZIP; la carpeta se limpia para no abandonar
  el lote anterior en cada intento.

Siempre después de confirmar la transacción: si el borrado en BD se revirtiera,
los archivos ya no estarían.

### Archivar no borra: le pone fecha

Archivar por error es común; recuperar una foto que ya no existe, imposible. Al
archivar se escribe `products.image_purge_at = hoy + 7 días` (misma transacción
que el archivado: son el mismo hecho) y un cron diario a las **03:00 hora
Colombia** borra lo vencido. Subir o quitar la imagen limpia esa marca.

La fila se despunta (`image = NULL`) **siempre**, aunque GCS no pueda borrar: si
no, el mismo borrado fallido se reintentaría cada día para siempre. El huérfano
queda registrado en el log.

### Duplicar y clonar copian el ARCHIVO

Copiar el string dejaría dos productos apuntando al mismo objeto: quitar la
imagen de uno borraría la del otro, en silencio. Por eso se hace una copia
server-side en GCS (el binario no pasa por el proceso) y cada producto es dueño
de su archivo. La copia ocurre **después** del commit —hablar con GCS dentro de
la transacción alargaría el lock por toda la latencia de red— y nunca lanza: si
falla, la copia nace sin foto y el usuario puede subirla.

Compartir a sucursal no copia nada: no hay fila nueva, la sucursal ve el producto
del principal con su misma imagen.

### El límite de multer va pegado al de negocio

Multer guarda el archivo en MEMORIA antes de que corra ninguna validación, así
que su `limits.fileSize` es lo que el API llega a retener por petición
concurrente. Por eso sale del MISMO origen que el límite real
(`resolveMaxImageSizeBytes`) más 1 KB de margen, y no de un techo holgado:
aceptar 32 MB en RAM para después rechazar por pasarse de 2 MB sería regalarle a
cualquier cliente autenticado 16× la memoria que la feature necesita. El margen
existe para que el archivo que se pasa por poco muera en `validateImageFile`
—con el mensaje que dice cuántos MB se permiten— en vez de en multer.

### El formato se decide por los bytes

El `Content-Type` del multipart lo escribe el cliente y se puede falsear. Se leen
los **magic bytes** (JPEG `FF D8 FF`, PNG, `RIFF…WEBP`) y de ahí sale la
extensión del objeto. Sin esto, cualquiera podría dejar un HTML o un ejecutable
en el bucket disfrazado de `image/png`.

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/inventory/image-settings` | Límites reales del servidor (peso, formatos, dimensiones sugeridas) y si hay almacenamiento configurado. |
| `POST` | `/inventory/:id/image` | Sube o reemplaza la imagen. Multipart, campo `image`. |
| `POST` | `/inventory/:id/image/remove` | Quita la imagen y la borra del bucket. Idempotente. |

`GET /inventory`, `GET /inventory/:id` y `GET /pos-data/items` devuelven además
`image` (ruta) e `image_url` (URL firmada, `null` si no hay imagen o si la firma
falló — el front cae al marcador y el listado nunca se rompe).

Autorización: `owner | manager` + permiso `canAccessInventory`, igual que crear y
editar productos. Un producto **archivado** no admite cambio de imagen (422): su
foto ya está en cuenta regresiva.

Códigos de error: `MISSING_IMAGE` (400), `INVALID_IMAGE_FORMAT` (400),
`IMAGE_TOO_LARGE` (413), `PRODUCT_ARCHIVED` (422),
`IMAGE_STORAGE_UNAVAILABLE` (503).

## Configuración

| Variable | Default | Para qué |
|---|---|---|
| `GCS_INVENTORY_BUCKET` | el de respaldos | Bucket destino. Vacío en ambos = feature deshabilitada (503 al subir; el resto del inventario sigue igual). |
| `GCS_INVENTORY_PREFIX` | `inventory_items` | Carpeta dentro del bucket. |
| `PRODUCT_IMAGE_MAX_MB` | `2` | Tope de peso. El formulario lo lee de `image-settings`, así que cambiarlo aquí lo cambia en los dos lados. |
| `PRODUCT_IMAGE_SIGNED_URL_TTL_S` | `86400` | Vigencia de la URL firmada. |
| `PRODUCT_IMAGE_CACHE_TTL_S` | `21600` | Vida de la URL en el caché (se recorta a la mitad de la vigencia de la firma). |
| `PRODUCT_IMAGE_RETENTION_DAYS` | `7` | Días que la imagen sobrevive tras archivar el producto. |

Las credenciales de GCS son las del proyecto (`GCS_CREDENTIALS_*`): las mismas
que usan los respaldos, resueltas por `common/gcs/gcs-credentials.ts`.

**Recomendación al usuario**: imagen cuadrada de 800×800 px, JPG/PNG/WebP, hasta
2 MB. Se ve nítida en la tarjeta del POS (que la pinta a ~120-200 px) y en
cualquier vista de catálogo, sin inflar el bucket ni la transferencia.

## Cliente (PlacePos)

El campo solo aparece si `GET /inventory/image-settings` responde con
`enabled: true`. En modo LAN esa ruta no existe (404, sin reintentos) y el
formulario queda exactamente como antes.

La imagen **no viaja en el payload del producto**: es un archivo que se sube
contra el id del item. Eso obliga a un orden concreto en creación —primero
existe el producto, después su foto— que encapsula `useProductImage`:

1. El usuario elige o quita la imagen → solo se guarda la intención.
2. El formulario guarda el producto y obtiene su id.
3. Llama a `syncImage(id)`, que sube o quita según corresponda e invalida las
   consultas del inventario y del POS.

Si el paso 3 falla, el producto **ya quedó guardado**: se avisa con un toast y se
cierra el formulario. Dejarlo abierto invitaría a guardar otra vez y a crear un
duplicado.

Tres detalles del cliente que costaron un bug cada uno:

- **El upload anula el `Content-Type`.** La instancia de axios declara
  `application/json`, y con ese header su `transformRequest` convierte el
  FormData en JSON (`{"image":{}}`): el archivo se pierde entero y el servidor
  responde siempre "Debes seleccionar una imagen". Pasar
  `{ headers: { 'Content-Type': undefined } }` deja que el navegador ponga el
  multipart con su `boundary`. Fijar `'multipart/form-data'` a mano NO sirve: va
  sin boundary. Cubierto por `uploadProductImage.test.ts`, que inspecciona el
  body en el adapter (un interceptor todavía ve el FormData intacto y daría un
  falso verde).
- **"¿Tiene imagen?" se decide por la RUTA, no por la URL.** Si la firma falla,
  `image_url` viene `null` pero el archivo existe; decidir por la URL dejaría esa
  imagen invisible **y** imposible de borrar.
- **El descarte de la selección se keyea por `productId`.** La URL firmada se
  renueva sola al expirar el caché: usarla como identidad hacía que un refetch de
  fondo borrara en silencio la foto recién elegida.
