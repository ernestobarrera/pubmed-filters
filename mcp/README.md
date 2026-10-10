# MCP: búsqueda PubMed literal con recibo

Un servidor MCP con **una sola herramienta**, `pubmed_search_exact`. Ejecuta una consulta PubMed **tal
cual** (por POST, sin reescribirla, sanearla ni trocearla) y devuelve el mismo **recibo** que
`scripts/pubmed-exact.mjs`: consulta enviada y su hash, diagnóstico de PubMed tal como llega, recuento,
PMIDs y `status.query_integrity`. Ese campo puede valer:

- `verified`: PubMed devolvió su diagnóstico y no descartó nada;
- `failed`: la consulta **no** se ejecutó como se escribió (término descartado, etiqueta de campo
  inexistente…). No uses el recuento;
- `unsupported`: no se puede verificar.

Es la pieza que permite usar el router desde un chat sin terminal. **No forma parte del router**: es un
adaptador más, y el router no sabe que existe.

Hay dos formas de usarlo, que no se excluyen:

| | Local (tu ordenador) | Remoto (Cloudflare Workers) |
|---|---|---|
| Desde dónde | Claude Desktop, Claude Code, VS Code | claude.ai, ChatGPT, Claude Desktop, móvil |
| Instalar | Node 18+ y nada más (sin `npm install`) | Una cuenta gratuita de Cloudflare, solo quien lo despliega |
| Compañeros | Cada uno lo instala | **Solo pegan una URL**; no necesitan Cloudflare |
| Exposición | Ninguna: no abre puertos | URL pública protegida por una clave en la propia URL |

---

## A. Local, en tu ordenador (10 minutos)

Requisito: [Node.js](https://nodejs.org) 18 o posterior (`node --version`) y una copia del repositorio.

**Claude Desktop.** Ajustes → *Developer* → *Edit Config*. Añade esto a `claude_desktop_config.json` con la
ruta real (en Windows, con barras dobles: `C:\\Users\\tu\\pubmed-filters\\mcp\\stdio.mjs`):

```json
{
  "mcpServers": {
    "pubmed-exact": {
      "command": "node",
      "args": ["/ruta/a/pubmed-filters/mcp/stdio.mjs"],
      "env": { "NCBI_API_KEY": "tu-clave-de-ncbi-opcional" }
    }
  }
}
```

Cierra Claude Desktop por completo y vuelve a abrirlo.

**Claude Code** (terminal o extensión de VS Code):

```
claude mcp add pubmed-exact -e NCBI_API_KEY=tu-clave -- node /ruta/a/pubmed-filters/mcp/stdio.mjs
```

**VS Code (modo agente de Copilot).** Crea `.vscode/mcp.json` en tu copia del repositorio. La clave se
pide al arrancar y no se guarda en el fichero:

```json
{
  "inputs": [{ "type": "promptString", "id": "ncbi-key", "description": "Clave de NCBI (opcional)", "password": true }],
  "servers": {
    "pubmed-exact": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/mcp/stdio.mjs"],
      "env": { "NCBI_API_KEY": "${input:ncbi-key}" }
    }
  }
}
```

**Comprobarlo:** pide en el chat *«usa pubmed_search_exact con `asthma [tiabb]`»*. Debe responder
`failed` con `ETIQUETA_IGNORADA`. La errata es a propósito: PubMed la acepta en silencio.

Detrás de un proxy corporativo, añade `"NODE_USE_ENV_PROXY": "1"` a `env`.

---

## B. Remoto, en Cloudflare Workers (unos 20 minutos, una sola vez)

Gratis dentro del plan gratuito (100.000 peticiones al día y 10 ms de CPU por petición; esperar a
PubMed no cuenta como CPU). Sin almacenamiento ni bases de datos: nada que mantener.

### B1. Una cuenta aparte (recomendado si ya usas Cloudflare para otra cosa)

La cuota gratuita es **por cuenta y la comparten todos sus Workers**. Una cuenta propia para esto deja
cualquier otro proyecto (por ejemplo, MedCheck) intacto, pase lo que pase aquí.

1. Abre <https://dash.cloudflare.com/sign-up> **en una ventana privada** (así no se mezcla con la sesión
   de tu otra cuenta) y crea una cuenta gratuita con otro correo. Verifica el correo.
2. En esa cuenta: menú **Workers & Pages** → la primera vez te pide elegir un **subdominio**
   `*.workers.dev`. Elige uno, por ejemplo `tunombre-pubmed`.
3. Crea un **token** solo para esta cuenta, para no tocar el inicio de sesión que ya uses en tu
   ordenador: icono de perfil → **My Profile** → **API Tokens** → **Create Token** → plantilla **Edit
   Cloudflare Workers** → en *Account Resources* elige **esta** cuenta → **Continue to summary** →
   **Create Token**. Copia el token; solo se muestra una vez.

### B2. Desplegar (desde el terminal de VS Code, en tu copia del repositorio)

Pon el token solo en esa ventana de terminal; desaparece al cerrarla:

```
# macOS / Linux
export CLOUDFLARE_API_TOKEN=pega-aquí-el-token

# Windows (PowerShell)
$env:CLOUDFLARE_API_TOKEN="pega-aquí-el-token"
```

Después:

```
cd mcp
npm ci                         # instala wrangler 4.135.0, la versión fijada
npx wrangler whoami            # COMPRUEBA que sale el correo de la cuenta NUEVA
npm run deploy                 # sella commit, contrato y código, y despliega (se niega con cambios sin commit)
```

Al terminar te dice la URL base, del tipo `https://pubmed-filters-exact.tunombre-pubmed.workers.dev`.
**Todavía no responde a nadie**: falta la clave de acceso (paso B3), y sin ella devuelve 503.

### B3. Secretos

Una **clave de acceso por persona**, de 32 caracteres o más. Genera una por cada persona que vaya a
usarlo (tú incluido):

```
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Ponlas todas juntas, separadas por comas, en un solo secreto:

```
npx wrangler secret put ACCESS_KEY      # pega: clave1,clave2,clave3
```

Apunta qué clave es de quién **fuera del repositorio** (por ejemplo, en tu carpeta privada de OneDrive).
Sin ninguna clave válida, o con alguna de menos de 32 caracteres, el Worker no atiende (503).

La URL de cada persona es la suya (**quien la tenga, puede usarlo**):

```
https://pubmed-filters-exact.tunombre-pubmed.workers.dev/mcp/<su-clave>
```

Opcionales:

```
npx wrangler secret put NCBI_EMAIL      # un correo de contacto para NCBI (ver Seguridad)
npx wrangler secret put NCBI_API_KEY    # NO tu clave personal (ver Seguridad)
```

### B4. Conectarla

- **claude.ai** (también en el plan gratuito, que admite un conector personalizado): botón **+** →
  **Connectors** → **Add custom connector** → pega la URL → **Add**. Actívalo en el chat.
- **ChatGPT** (planes de pago): Ajustes → Connectors → Advanced → **Developer mode**. Después **Create
  connector**, pega la URL, autenticación **No authentication**, marca que confías en él → crear.
  Actívalo en el chat. Los nombres de los menús cambian entre versiones.

Comprueba con `asthma [tiabb]`, como en A. La errata es a propósito: PubMed la acepta en silencio y
devuelve 246.024 registros como si nada, y el conector debe responder `failed`. Además, prueba una
búsqueda normal, que debe dar `verified`.

**Sin probar todavía en ningún chat real.** El servidor cumple la versión 2025-06-18 del protocolo y
pasa sus pruebas, pero que claude.ai y ChatGPT lo acepten se comprueba al conectarlo. Si un chat
rechaza la conexión por el origen (403), añade ese origen a `ALLOWED_ORIGINS`
(`npx wrangler secret put ALLOWED_ORIGINS`, por ejemplo `https://claude.ai`).

### B5. Compartirlo con compañeros

Envía a cada uno **su** URL. Solo tienen que hacer B4. No necesitan Cloudflare, Node ni el repositorio.

- **Retirar el acceso a una persona:** vuelve a poner `ACCESS_KEY` sin su clave. Las demás siguen.
- **Actualizar** tras cambios en el repositorio: `git pull` y `npm run deploy` (con el token puesto).
  El despliegue **se niega** si hay cambios sin commit, y los recibos dicen qué commit y qué ficheros
  (`code_sha256`) están desplegados.

---

## Seguridad: qué viaja y qué no

- **A PubMed** solo llega la consulta, `tool=pubmed-filters-mcp` y, si los pusiste, `NCBI_EMAIL` y
  `NCBI_API_KEY`. Ninguno de los dos aparece en ningún recibo (pruebas M8 y M9).
- **`NCBI_EMAIL`**: NCBI pide un contacto junto a `tool` para poder avisar antes de bloquear un
  servicio que abuse. Es recomendable y no es obligatorio. Usa un correo de contacto del servicio, no uno
  que no quieras ver en los registros de NCBI. Nunca se escribe en el repositorio.
- **`NCBI_API_KEY`: no pongas tu clave personal.** La cuota de NCBI es **por clave**, y la compartirían
  el Worker y cualquier otra herramienta tuya que la use: un abuso desde una URL filtrada te dejaría sin
  cuota también en ellas. Una cuenta de Cloudflare aparte no lo aísla. Dos opciones seguras:
  1. **Sin clave** (recomendado para empezar): funciona igual, a 3 peticiones por segundo.
  2. **Una clave solo para esto**: crea una cuenta de NCBI aparte y genera allí la clave. Así un
     abuso solo afecta al Worker.
- **Qué guarda el servidor:** nada. No escribe registros ni almacena consultas, y los registros de
  Cloudflare están desactivados en `wrangler.toml`, porque la clave de acceso viaja en la ruta de la URL.
- **Solo lectura:** la herramienta no puede escribir en ningún sitio.
- **Cerrado por defecto:** sin claves válidas no atiende (503). Una ruta o clave desconocida devuelve 404,
  sin pistas. Una petición de navegador desde un origen no declarado, 403. Un cuerpo de más de 64 KiB,
  413, sin llegar a leerlo entero. Una ráfaga que no cabe en la cola se rechaza.
- **Límites conocidos:** el espaciado entre llamadas a NCBI es por instancia, no global, y no hay
  reintentos: un 429 o un 502 de NCBI llegan como error declarado, nunca como un cero.

## Pruebas

```
node mcp/test.mjs     # protocolo y transporte HTTP, sin red (también corre en la CI y en la puerta de mutación)
```

Probado a mano el 2026-10-08 con el cliente oficial del SDK de MCP (1.32.1), por stdio y por HTTP,
contra PubMed real. Sin probar todavía dentro de `workerd` contra PubMed, ni desde claude.ai o ChatGPT.
