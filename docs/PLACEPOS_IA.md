# Place — módulo `ai`

**Place** es el asistente del negocio. Vive **solo en pos_api** (cloud-only) por
dos razones: la llave de Google nunca debe viajar al cliente, y el asistente
consulta la base de datos multi-tenant para responder con cifras reales.

El servidor Express local de placepos (modo LAN) **no** tiene gemelo de este
módulo — el cliente lo detecta y muestra un aviso explicativo.

## Identidad

Place tiene nombre propio y una razón de ser, y ambos viven en el prompt de
sistema (`internal/system-prompt.ts`, constante `ASSISTANT_NAME`):

> Que el dueño y su equipo entiendan su negocio sin tener que abrir informes ni
> sacar cuentas a mano — convirtiendo los datos que ya están en PlacePOS en una
> respuesta clara y en la siguiente decisión.

Reglas de identidad que el prompt fija: se llama Place (nunca "Gemini", "Google"
ni "un modelo de lenguaje"), trabaja solo con los datos de ESTE negocio, no
tiene internet, no maquilla los números malos y solo recuerda la conversación en
curso. El cliente muestra el nombre que venga en `/ai/status`, nunca uno propio.

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/ai/status` | `{ enabled, assistantName, defaultModel, models, tools }`. El cliente lo consulta antes de abrir el chat. `tools` viene **ya filtrado por los permisos del usuario**: es la misma lista que se le declara al modelo, así que la pantalla nunca promete un informe que este usuario no puede ver. |
| `GET` | `/ai/greeting` | `{ text, source }` — el saludo de bienvenida, escrito por Place. |
| `POST` | `/ai/chat` | Stream **SSE** (`text/event-stream`) con la respuesta del asistente. |

### `GET /ai/greeting`

El texto de bienvenida no es una constante: lo escribe Place en cada visita,
mencionando **siempre** el nombre del negocio y solo las áreas que ese usuario
puede consultar (un vendedor sin informes no ve prometido "cartera y gastos").

Defensas, porque el texto lo produce un modelo:

- `sanitizeGreeting` aplana saltos de línea, quita markdown y comillas, y
  **rechaza** lo que no nombre al negocio o se salga de 40–220 caracteres. Lo
  rechazado cae al saludo fijo (`source: "fallback"`).
- Se cachea en memoria por `company_id:user_id` durante 30 minutos: abrir y
  cerrar el chat diez veces no cuesta diez llamadas a Google. El *fallback* no
  se cachea, para reintentar con la IA en la siguiente visita.
- Si la IA está apagada, falla o revienta, siempre sale el saludo fijo. Esta
  pantalla no puede quedarse muda.

`POST /ai/chat` recibe el historial completo (el backend es **sin estado**; el
historial vive en el cliente):

```json
{ "turns": [{ "role": "user", "content": "¿Cuánto vendí hoy?" }] }
```

`model` es opcional y el cliente **no lo manda**: el modelo lo decide el
servidor (`GEMINI_DEFAULT_MODEL`). El campo se conserva en el DTO para pruebas
y para poder abrir la elección más adelante sin romper el contrato.

Eventos del stream:

| Evento | Datos | Significado |
|---|---|---|
| `delta` | `{ text }` | Pedazo de la respuesta. |
| `tool`  | `{ name, label, status }` | El asistente está consultando la base (`running` → `done`/`error`). |
| `done`  | `{ notice? }` | Terminó. `notice` explica un corte anómalo (p. ej. límite de longitud). |
| `error` | `{ message }` | Mensaje en español, listo para mostrarle al usuario. |

Si el cliente cierra la conexión, la generación se aborta (deja de gastar tokens).

## Herramientas (function calling)

Todas son **de solo lectura** y **todas** filtran por `company_id`. Antes de
ejecutarse se revalida el permiso: que el modelo invente una llamada no basta.

Cada herramienta lleva además un `summary` en el idioma del comerciante — es lo
que el cliente lista en "Qué puede consultar Place". La `description` de la
declaración es para el modelo; el `summary`, para la persona.

| Herramienta | Permiso | Fuente |
|---|---|---|
| `get_daily_summary` | `canAccessDashboard` | `DashboardService.today` |
| `list_sales` | `canAccessSalesReport` | SQL sobre `sale_invoices` + líneas, pagos y cliente. Acotada por `canViewAllSales` (un empleado sin ese permiso solo ve sus ventas). |
| `get_performance_range` | `canAccessDashboard` | `DashboardService.performance` |
| `get_top_products` | `canAccessDashboard` | `DashboardService.topProducts` |
| `search_products` | `canAccessInventory` | SQL sobre `products` (+ compartidos por la principal) |
| `get_low_stock` | `canAccessInventory` | SQL sobre `products` |
| `get_debtors` | `canAccessCreditsReport` | SQL sobre `sale_credits` + `customers` |
| `search_customers` | `canAccessCustomers` | SQL sobre `customers` |
| `get_expenses_summary` | `canAccessExpenses` | SQL sobre `expenses` |
| `get_treasury_accounts` | `canAccessBanks` | `TreasuryService.accounts` |

Las métricas financieras **no se recalculan aquí**: se reutiliza la maquinaria
canónica (dashboard/tesorería) para que la IA diga exactamente los mismos
números que las pantallas.

> **Regla que costó un bug (28 jul 2026):** toda herramienta con SQL propio debe
> filtrar igual que su informe canónico. `get_debtors` sumaba créditos de ventas
> **anuladas** (no hacía JOIN con `sale_invoices`) y reportaba $ 279.500 donde
> Cartera decía $ 147.300; `search_customers` leía `customers.balance`, una
> columna que no se mantiene al día (negocios enteros con todos los clientes en
> 0 debiendo dinero). Los filtros compartidos viven ahora en
> `internal/tool-sql.ts`, probados en `__tests__/tool-sql.spec.ts`. Un `WHERE`
> incompleto no se ve como un bug: se ve como una alucinación del modelo, porque
> la IA repite con total seguridad lo que la herramienta le entrega.

Un empleado sin `can_view_profit` recibe los resultados **sin** costo, ganancia
ni margen (`stripProfitFields`) y el prompt de sistema le prohíbe mencionarlos.

## Configuración

| Variable | Por defecto | Notas |
|---|---|---|
| `GEMINI_API_KEY` | *(vacía)* | **Sin ella el módulo responde `enabled: false`** y el chat queda deshabilitado. |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | Solo para proxies o pruebas. |
| `GEMINI_DEFAULT_MODEL` | `gemini-flash-lite-latest` | Flash-Lite: el más rápido y barato, que es lo que pide un asistente que lee datos y los resume. Usa los alias `-latest`: apuntan al modelo vigente de cada familia. Los `gemini-2.5-*` están **jubilados para proyectos nuevos** — `ListModels` los sigue listando pero `generateContent` responde 404 "no longer available to new users". |
| `GEMINI_ALLOWED_MODELS` | `gemini-flash-lite-latest,gemini-flash-latest,gemini-pro-latest` | Coma-separada. Un modelo fuera de la lista cae al de defecto. El cliente no elige: es una barrera por si alguien llama la API a mano. |
| `GEMINI_TEMPERATURE` | `0.7` | |
| `GEMINI_MAX_OUTPUT_TOKENS` | `4096` | |
| `GEMINI_REQUEST_TIMEOUT_MS` | `120000` | Corte duro de la petición a Google. |
| `GEMINI_MAX_TOOL_ROUNDS` | `4` | Rondas de consulta a la base por mensaje. En la última se le quitan las herramientas al modelo para forzar una respuesta de texto. |

> **Despliegue:** hay que definir `GEMINI_API_KEY` en el `.env` de producción.
> La llave se factura por uso: si el proyecto de Google se queda sin créditos, la
> API devuelve `429` y el chat muestra "La cuenta de Google AI se quedó sin
> créditos" (no es un bug del módulo).

## Estructura

```
modules/ai/
├── ai.controller.ts              # /ai/status, /ai/greeting y /ai/chat (SSE, @Res crudo)
├── ai.service.ts                 # facade
├── actions/
│   ├── stream-ai-chat.action.ts  # ciclo generar → herramientas → generar
│   ├── run-ai-tool.action.ts     # ejecuta las herramientas contra la BD
│   ├── generate-ai-greeting.action.ts # saludo de bienvenida (+ caché 30 min)
│   └── resolve-ai-actor.action.ts# permisos efectivos + contexto del negocio
└── internal/
    ├── gemini-client.ts          # único punto impuro (fetch + stream)
    ├── gemini-request.ts         # historial → body de la API   (puro)
    ├── gemini-sse.ts             # parseo del SSE de Google      (puro)
    ├── gemini-errors.ts          # errores → español             (puro)
    ├── system-prompt.ts          # identidad y reglas            (puro)
    ├── greeting.ts               # saludo: prompt, saneo, fijo   (puro)
    ├── tool-catalog.ts           # declaraciones + permisos      (puro)
    ├── tool-args.ts              # lectura defensiva de argumentos (puro)
    └── sse-writer.ts             # escritura SSE + heartbeat
```

Sin entidades ni migración: el módulo no persiste nada.
