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

**Comprobarlo:** pide en el chat *«usa pubmed_search_exact con `asthma[tiabb]`»*. Debe responder
`failed` con `ETIQUETA_DESCONOCIDA`: la errata `[tiabb]` que PubMed acepta en silencio.

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
npm run deploy                 # sella commit y contrato, y despliega
```

Al terminar te dice la URL base, del tipo `https://pubmed-filters-exact.tunombre-pubmed.workers.dev`.
**Todavía no responde a nadie**: falta la clave de acceso (paso B3), y sin ella devuelve 503.

### B3. Secretos

```
node -e "console.log(crypto.randomUUID())"   # genera una clave de acceso larga y aleatoria; cópiala
npx wrangler secret put ACCESS_KEY           # pégala
npx wrangler secret put NCBI_API_KEY         # opcional: tu clave de NCBI
```

Tu URL de conexión queda así (guárdala bien: **quien la tenga, puede usarlo**):

```
https://pubmed-filters-exact.tunombre-pubmed.workers.dev/mcp/<ACCESS_KEY>
```

### B4. Conectarla

- **claude.ai** (también en el plan gratuito, que admite un conector personalizado): botón **+** →
  **Connectors** → **Add custom connector** → pega la URL → **Add**. Actívalo en el chat.
- **ChatGPT** (planes de pago): Ajustes → Connectors → Advanced → **Developer mode**. Después **Create
  connector**, pega la URL, autenticación **No authentication**, marca que confías en él → crear.
  Actívalo en el chat. Los nombres de los menús cambian entre versiones.

Comprueba con `asthma[tiabb]`, como en A.

### B5. Compartirlo con compañeros

Envíales la **URL completa**. Solo tienen que hacer B4. No necesitan Cloudflare, Node ni el
repositorio.

- **Retirar el acceso a todos:** `npx wrangler secret put ACCESS_KEY` con una clave nueva. La URL
  vieja deja de funcionar al instante; reparte la nueva.
- **Actualizar** tras cambios en el repositorio: `git pull` y `npm run deploy` (con el token puesto).
  Los recibos dicen qué commit está desplegado.

---

## Seguridad: qué viaja y qué no

- **A PubMed** solo llega la consulta, `tool=pubmed-filters-mcp` y, si la pusiste, tu clave de NCBI.
  **Nunca tu correo** ni datos personales.
- **La clave de NCBI** se guarda como secreto de Cloudflare: no está en el código, en el repositorio ni
  en ningún recibo (lo comprueba la prueba M8). Si alguien con tu URL abusara, el riesgo es que agote
  tu cuota de NCBI o que NCBI te pida bajar el ritmo; tu clave no queda expuesta. Cambiar
  `ACCESS_KEY` lo corta al instante. Si te preocupa, puedes no ponerla: funciona igual, más despacio
  (3 peticiones por segundo en vez de 10, compartidas con otros usuarios de Cloudflare).
- **Qué guarda el servidor:** nada. No escribe registros ni almacena consultas.
- **Solo lectura:** la herramienta no puede escribir en ningún sitio.
- **Cerrado por defecto:** sin `ACCESS_KEY` el Worker no atiende (503). Cualquier ruta distinta de la
  tuya devuelve 404, sin pistas de qué hay detrás.

## Pruebas

```
node mcp/test.mjs     # protocolo y transporte HTTP, sin red (también corre en la CI)
```

Probado a mano el 2026-10-08 con el cliente oficial del SDK de MCP (1.32.1), por stdio y por HTTP,
contra PubMed real.
