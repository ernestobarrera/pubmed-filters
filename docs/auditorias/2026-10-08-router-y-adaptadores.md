# Auditoría del router neurosimbólico, su contrato de ejecución PubMed y los adaptadores

**Fecha de ejecución:** 2026-10-08 (09:10–11:30 UTC aprox.)
**Rama:** `claude/cool-turing-nxt4ym` (no se ha tocado `main`)
**Estado de partida, registrado al inicio:**

| Elemento | Valor |
|---|---|
| `main` = HEAD de partida | `43054b145e586b7740e0075897d7db715e4c3dbf` (sin cambios respecto a la auditoría previa) |
| `neurosymbolic_router.json` | sha256 `f86aa11a…c250b` · versión 1.8.0 |
| `scripts/parse-filter.mjs` | sha256 `e4e00424…56bf5ce` |
| `scripts/esearch.mjs` | sha256 `780779cd…6d3` |
| `scripts/validate-router.mjs` | sha256 `43f5e675…8bef` |
| `scripts/sweep-filters.mjs` | sha256 `88db19f8…91d8` |
| `scripts/sweep-baseline.json` | sha256 `caa99de0…7ca` (medido el 2026-10-01) |
| `journal_filters_data.js` | sha256 `c39a0239…357d` |
| Node | v22.22.0 |

Los hashes completos están en el historial de la sesión; los abreviados bastan para identificar el estado porque el commit lo fija.

---

## Estado vigente (lee esto primero)

Este informe se escribió en cinco tiempos el mismo día: la auditoría (§A–§L), las correcciones tras la revisión de ChatGPT (§0bis), las medidas con red (§0ter) y dos rondas de revisión adversarial de Codex (§0quater y §0quinquies). **Si una sección anterior contradice a una posterior, manda la posterior.** Las secciones A, G, K y L se conservan como registro y no como plan: lo que llaman «diferido» en parte ya está hecho, y la propuesta de PR a cyanheads quedó **descartada** porque el propietario no quiere tocar repositorios ajenos.

Situación actual:

- **Ejecutor y juicio:** corregidos tras dos rondas de Codex (§0quater, §0quinquies). Detectan todo lo que PubMed ignora en silencio y se ha medido: etiquetas inexistentes, también con espacio; etiquetas sobre grupos con AND, OR o NOT; modificadores fuera de sitio; proximidad que no va sobre una frase válida; y asteriscos tipográficos, también dentro de frases.
- **Contrato:** 1.9.0.
- **MCP:** endurecido, pero **sin desplegar y sin probar en ningún chat real**.
- **Pendiente de decisión del propietario:** corregir los asteriscos tipográficos de `filters/methodology/horizon.txt` (§0quater).

---

## 0. Qué se pudo y qué no se pudo ejecutar

Esto condiciona todo lo demás, así que va primero.

- **Suite de conformidad:** ejecutada. Al inicio, **51 pass / 0 fail**. Al final, **56 pass / 0 fail**.
- **Puerta de mutación:** ejecutada tras los cambios, **15/15 mutaciones detectadas**. La propia puerta cazó un fallo mío a mitad de trabajo (ver §G).
- **Barrida live (`sweep-filters.mjs`): NO ejecutada.** La política de red del contenedor deniega `eutils.ncbi.nlm.nih.gov` (CONNECT 403). WebFetch tampoco resuelve hosts de NCBI, NLM ni OpenAlex. **La línea base no se ha tocado.**
- **PubMed por E-utilities directo: NO disponible.** No he podido reproducir ninguna respuesta cruda de ESearch nueva. Los vectores de NCBI se apoyan en las respuestas reales ya capturadas en `scripts/fixtures/respuestas-pubmed.json`.
- **Conector PubMed nativo de este entorno** (las herramientas PubMed de esta sesión de Claude): **disponible y probado a fondo**. Es una superficie distinta de la «PubMed nativa de ChatGPT» del incidente; no extrapolo de una a otra.
- **Sider Scholar y la PubMed nativa de ChatGPT:** no disponibles aquí. **NO REPRODUCIDO**; sus observaciones previas se tratan como antecedentes.
- **Código de cyanheads, BioMCP y semantic-scholar-mcp:** clonado de GitHub e inspeccionado en su commit actual. Las dependencias npm sí se alcanzan, así que el saneado de cyanheads se ejecutó de verdad.
- **OpenAlex, Semantic Scholar, Europe PMC y Crossref:** APIs bloqueadas. **El mini-benchmark OQL del §21 NO se ha ejecutado.** Lo que digo de esas fuentes viene de búsqueda web (resúmenes de páginas oficiales y de terceros), y lo marco así.
- **Fuentes metodológicas** (Cochrane cap. 4, PRESS, PRISMA-S, TARCiS): no se han podido reabrir en esta sesión. Las uso por su contenido conocido y estable, marcado DOCUMENTADO.

Si quieres cerrar estos huecos: en la configuración del entorno, **Network access**, añade a *Allowed domains* `eutils.ncbi.nlm.nih.gov`, `api.openalex.org`, `api.semanticscholar.org`, `www.ebi.ac.uk` y `api.crossref.org`, o sube el nivel de acceso (pasos: <https://code.claude.com/docs/en/cloud-environments#network-access>). Después, en este orden: `node scripts/sweep-filters.mjs`, y el ejecutor nuevo sobre los vectores de §I.

---

## 0bis. Correcciones tras la revisión externa (2026-10-08, tarde)

Una revisión independiente del informe y de la rama señaló cuatro puntos. Así quedan:

1. **Ventana de ESearch: 9.999 frente a 10.000. Aceptada en principio, y luego REFUTADA por la medición directa (ver §0ter).**
   - La primera versión del ejecutor fijaba `ESEARCH_WINDOW = 9999` y rechazaba `retmax=10000`. Con eso convertía lo observado en un adaptador en una verdad sobre PubMed.
   - Según la revisión, NCBI documenta `retmax ≤ 10000` y `retstart + retmax ≤ 10000`. No he podido abrir la página porque la red está bloqueada.
   - Medido de nuevo en el conector: `retstart=9998` devuelve **un solo** registro aunque se pidan 2 o 3, y `retstart=9999` da cero. La ventana observable es de **9.999**.
   - cyanheads lo confirma de forma independiente en su código: «NCBI's eSearch serves `retstart` up to 9998 for PubMed and fails the whole request above it».
   - **Decisión:**
     - El ejecutor acepta lo documentado: `retmax=10000` se envía y `10001` no (E4 y mutación E-VENTANA).
     - Declara las dos cifras (`ESEARCH_DOCUMENTED_WINDOW`, `ESEARCH_OBSERVED_WINDOW`) sin elegir verdad.
     - Si NCBI rechaza, el ejecutor ya no puede convertirlo en cero (Q7/E3).
     - **Pendiente con red:** medir `retmax=10000` y `retstart=9999` directamente contra E-utilities.

2. **Polisemia de `failed`. Aceptada.**
   - `operational_status` es un vocabulario compartido por tres dimensiones, y «cobertura fallida» o «lectura fallida» no significan nada definido.
   - 1.9.0 añade `values_by_dimension`: `failed` vale solo para `query_integrity`; `coverage` y `reading_depth` conservan `verified | planned | unsupported`.
   - Lo vigilan C13 y la mutación C13-POLISEMIA.
   - No adopto la alternativa de rediseñar `coverage` y `reading_depth` con vocabularios propios: cambiaría la semántica existente sin una prueba que lo pida.

3. **Diagnóstico parcial. Aceptado el matiz.**
   - «Vale lo mismo que no tener diagnóstico» era inexacto. Lo correcto: un diagnóstico parcial con una anomalía observada da `failed`; sin anomalía observada da `unsupported`.
   - Así queda escrito en `value_meanings`.
   - La granularidad de capacidades de un adaptador (qué campos devuelve) sigue siendo útil para auditar la infraestructura. Su sitio es la declaración de conformidad del adaptador, no el núcleo del router.

4. **`NotIndexed`: «impacto nulo» era demasiado. Aceptado.**
   - El impacto directo sobre los filtros del registry es nulo, pero el componente neural puede construir un concepto solo con `[mh]`.
   - 1.9.0 añade `composition.indexing_status_is_not_mesh`: `Status=MEDLINE` no implica MeSH; cuando importa la sensibilidad, MeSH se acompaña de texto libre, y depender solo de MeSH es legítimo si es deliberado y se declara.
   - R15 falla si un filtro empieza a usar `medline[sb]`, `inprocess[sb]`, `pubmednotmedline[sb]` o `publisher[sb]` sin declararlo (mutación R15-ESTADO).

**Estado tras las correcciones:** suite **58/0**; puerta de mutación **18/18**. El commit `9d3fe40` (recuento estricto) sigue siendo independiente y fusionable por separado.

---

## 0ter. Resultados con acceso real a E-utilities (2026-10-08, ~11:30–12:30 UTC)

Con la red abierta a `eutils.ncbi.nlm.nih.gov`, todo lo de esta sección es **REPRODUCIDO** contra PubMed. Las respuestas crudas relevantes son ahora fixtures reales en `scripts/fixtures/respuestas-pubmed.json`.

**Barrida live (`sweep-filters.mjs`):** 122 filtros; 118 limpios; 4 con los descartes ya aceptados (revistas no indexadas); **ningún cambio respecto a la línea base del 2026-10-01**. La base no se ha tocado porque no había nada que clasificar.

**Vectores adversariales contra PubMed real:**

| Vector | Respuesta de PubMed | Juicio |
|---|---|---|
| MeSH inventado | 0 + `quotedphrasesnotfound` | `failed` (cero roto) |
| Cero legítimo (`1804[dp]`) | 0, sin descartes | `verified` |
| `rettype=count` | 0 **sin** `querytranslation` | `unsupported` |
| `"body battery"` dentro de un OR | 6 registros + `quotedphrasesnotfound` | `failed` |
| 15 frases inexistentes | 0; la traducción repite la consulta, pero **`quotedphrasesnotfound` lista las 15** | `failed`: con el diagnóstico completo, el eco de B4 deja de engañar |
| `the[tiab] AND asthma[tiab]` | 0 + `errorlist.phrasesnotfound: ["the"]` | `failed` |
| **`asthma[foo]`** | **246.024 registros, `fieldsnotfound` vacío, ningún aviso** | antes `verified` → **ahora `failed`** |
| **`asthma[tiabb] OR copd[tiab]`** | **307.318 registros, ningún aviso** | **ahora `failed`** |
| Síntesis compuesta (1.942 caracteres) | 9.247, limpia | `verified` |
| Consulta de 6.304 caracteres por POST | 1.143 + 60 frases inventadas descartadas | `failed`; el transporte, íntegro |
| `metformin[tiab]` + `humans` (NOT) | 30.300, NOT en la traducción | `verified` |
| `"BMJ Simulation & Technology Enhanced Learning"[jour]` | 443 | `verified` |
| La misma con `&amp;` (lo que deja el saneado de cyanheads) | **0** + aviso | `failed`: **el efecto de B17 queda reproducido** |
| `retstart` 9990, `retmax` 10 | 9 PMIDs + «Restrictions achieved. start and count adjusted to 9990, 9» | antes `failed` por «aviso semántico» → **ahora aviso de paginación, sin invalidar** |
| `retstart` 0, `retmax` 10000 | 9.999 PMIDs + «Restrictions achieved… 0, 9999» | idem |
| `retstart` 9999 | `ERROR`: «'retstart' cannot be larger than 9998. For PubMed, ESearch can only retrieve the first 9,999 records», **en JSON inválido** (salto de línea crudo) | antes, error de parseo genérico → **ahora `RESPUESTA_ILEGIBLE` con el mensaje de PubMed** |

**Conclusiones nuevas:**

1. **La ventana es de 9.999, y lo dice PubMed.** La documentación de NCBI dirá 10.000, pero el servidor declara 9.999 en su propio ERROR. El ejecutor vuelve a `ESEARCH_WINDOW = 9999` (E4, mutación E-VENTANA) y deja escrita la historia de la cifra. Con esto, el defecto del conector del entorno (B9) queda bien acotado: **la frontera es de PubMed; convertir su ERROR en `total_count: 0` es del conector**. Y se entiende por qué ocurre: ese ERROR no es JSON válido, y un parser que falla y cae a 0 fabrica el cero.
2. **Hallazgo nuevo y el más grave: las etiquetas de campo inexistentes son invisibles incluso con el diagnóstico completo.** Ni `warninglist` ni `errorlist` las reportan. Hasta hoy, el contrato 1.8 y el ejecutor habrían dado `verified` a `asthma[tiabb]`. Se corrige así:
   - `inspectResponse(r, { sentQuery })` compara las etiquetas de la consulta enviada con `PUBMED_FIELD_TAGS`, una lista verificada en vivo etiqueta por etiqueta: con una etiqueta válida la traducción cambia de campo; con una inexistente queda idéntica a la del término sin etiqueta.
   - Regla nueva `query_execution_contract.field_tags_are_not_reported`, con su vector.
   - Pruebas Q8 y E6; R16 comprueba que las 27 formas de etiqueta distintas usadas por los 122 filtros son reales (lo son, incluido `[jo]`, que aparece 1.460 veces).
   - Mutaciones Q8-SIN-ETIQUETAS y R16-ERRATA.
3. **«Restrictions achieved» no es un problema de integridad.** Es PubMed recortando la página. Se informa en `pagination` / `pagination_notices` (Q9, mutación Q9-PAGINACION). Regla nueva `pagination_window`.
4. **Node detrás de proxy:** `fetch` necesita `NODE_USE_ENV_PROXY=1`. Documentado en el README.
5. **Comprobación de punta a punta del ejecutor:** asma pediátrica + síntesis + guías, 3.625 caracteres por POST: 726 registros, `verified`; recupera 200 y declara `records_complete: false`. `quickstart.mjs` funciona igual que antes.

**Estado final:** suite **63/0**; puerta de mutación **22/22**.

**Lo que sigue sin probar:** OpenAlex, Semantic Scholar, Europe PMC y Crossref (no se abrieron; no hacían falta para decidir sobre el núcleo); el benchmark OQL; Sider y la PubMed nativa de ChatGPT.

---

## 0quater. Revisión adversarial de Codex y lo que se hizo con ella (2026-10-08, tarde)

Codex revisó la cabeza `8e1e5e0` con las suites, 15 peticiones a PubMed y el MCP por stdio. Su veredicto: no fusionar entero ni desplegar. Cada hallazgo se **reprodujo de nuevo en vivo** antes de tocar nada. Todo lo que sigue es REPRODUCIDO contra E-utilities, y las respuestas nuevas son fixtures reales.

| Hallazgo de Codex | Verificación propia | Arreglo |
|---|---|---|
| F1 `asthma [tiabb]` sale `verified` (la regex exigía el corchete pegado) | Confirmado: 246.024, ningún aviso. PubMed aplica las etiquetas aunque haya espacios: `asthma [tiab]` = 195.441 = `asthma[tiab]` | `fieldTagIssues()` recorre la consulta con contexto en vez de usar una regex |
| F2 una anomalía sin `querytranslation` sale `unsupported` | Confirmado en código | `queryIntegrity` mira antes las anomalías conocidas (E8) |
| F2b sin `sentQuery` el juicio da por buena la consulta (y Q8 lo exigía) | Confirmado | sin consulta enviada: `ETIQUETAS_NO_COMPROBADAS`; sweep y quickstart la pasan |
| F3 Worker: Origin, versión y lotes sin controlar | Confirmado | 403 para orígenes no declarados, 400 para versiones no soportadas y para lotes; solo se anuncia la 2025-06-18 |
| F4 límite de cuerpo tardío y por caracteres | Confirmado | lector acotado por bytes, más `Content-Length` (W6) |
| F5 un hash fijo de PMIDs pasaba las suites | Confirmado | E9 con cálculo independiente, y mutación |
| F6 `"[18F]FDG"[tiab]` marcada como etiqueta | Confirmado: búsqueda válida, 13.894 | las comillas se respetan |
| F6b modificadores sin validar | Confirmado: `asthma[mh:~3]` y `asthma[ti:noexp]` se ignoran sin aviso | `:~N` solo en ti/tiab/ad; `:noexp` solo en MeSH, subencabezado y tipo de publicación |
| D14 no poner la clave NCBI personal | De acuerdo: la cuota es por clave | guía: sin clave, o una de una cuenta NCBI aparte |
| D13 una clave común para todos | De acuerdo | varias claves, una por persona, de 32 caracteres o más |
| Falta `email` | De acuerdo, sin datos en el repo | `NCBI_EMAIL` opcional, solo a NCBI (M9) |
| Sellado con árbol sucio | De acuerdo | `stamp --deploy` se niega, y sella el SHA-256 de cada fichero de código |
| D7 la cifra 9.999 no debe ser normativa | De acuerdo | `pagination_window` la trata como límite observado y fechado |
| D6 R15 solo miraba `[sb]` | De acuerdo | también `[subset]` y `[filter]` (medido: `medline[filter]` = `medline[subset]`) |

**Lo que Codex no vio y salió al rehacer la heurística:**

1. **Etiqueta sobre grupo.** `(asthma OR copd)[tiab]` → 351.416 registros por ATM en todos los campos, frente a 257.958 de `asthma[tiab] OR copd[tiab]`. Ningún aviso. Un paréntesis sin operadores sí funciona (`Front Endocrinol (Lausanne)[JO]`).
2. **Asteriscos tipográficos en un filtro curado.** `filters/methodology/horizon.txt` lleva `∗` (U+2217, copiado del PDF del artículo) en seis términos: `emergente∗`, `intervent∗`, `surger∗`, `tool∗`, `transplant∗` y, dentro del bloque de exclusión, `VACCIN∗`. PubMed busca la raíz exacta sin avisar: `intervent∗[ti]` = 9 registros frente a 269.566; `VACCIN∗[ti]` = 20 frente a 264.448, así que la exclusión de vacunas casi no excluye. El filtro entero da 356.107 registros tal cual y 420.561 corregido (+18 %). Ninguna barrida lo había visto, porque PubMed no lo reporta. **No se ha corregido:** cambia el recall de un filtro publicado y es decisión del propietario. Queda declarado en `registry_validation.terms_pubmed_drops.typographic_truncation`, y R17 falla si aparece otro caso.
3. **`[author identifier]`** no es una etiqueta (PubMed la ignora; la buena es `[auid]`). Se quitó de la lista. Las demás se verificaron una a una con un término de su campo.

**En qué no estoy de acuerdo con Codex:**

- **D4, partir el PR en tres.** Fusionar no despliega nada: el Worker solo sale con `npm run deploy`, y ahora este se niega con el árbol sucio. La seguridad la da esa puerta, no el número de PRs. Partirlo es razonable si se prefiere revisar por partes; no es necesario para la seguridad.
- **«Un objeto con solo traducción pasa como verified».** Es cierto, y no tiene arreglo dentro de `inspectResponse`: una respuesta impecable de ESearch tampoco trae `warninglist`, así que lo recortado y lo limpio son indistinguibles en el objeto. La procedencia la garantiza quien llama: el ejecutor habla con ESearch directamente. Queda escrito en la documentación de la función.

**Estado:** suite **66/0**; MCP **16/0**; puerta de mutación **38/38**. Ahora corre también las pruebas del MCP, con once mutaciones del ejecutor, el juicio y el Worker. **Sigue sin probar:** el Worker dentro de `workerd` contra PubMed, y la aceptación real en claude.ai y ChatGPT.

---

## 0quinquies. Segunda ronda de Codex (2026-10-08, noche)

Codex revisó `b466d78`. Cierra F1–F5, el sellado, el email, R15 y D7. Acepta los dos desacuerdos de §0quater: no hace falta partir el PR, y la procedencia la garantiza quien llama. Deja como parciales F6, D13 y D14. Todo lo que sigue se reprodujo en vivo, y las respuestas son fixtures reales.

| Hallazgo | Medido | Arreglo |
|---|---|---|
| Asterisco tipográfico **dentro de una frase** sale `verified` | `"randomized trial∗"[tiab]` = 65.068 sin truncar, frente a 109.950 con `*` | `lookalikeCharacters()` ya no vacía las comillas antes de mirar |
| Proximidad sobre una frase **con comodín** sale `verified` | `"asthma* control"[tiab:~2]` = 10.391: PubMed tira la proximidad | `:~N` solo vale sobre una frase entrecomillada de dos o más palabras, sin comodines |
| *(nuevo, al corregir)* Proximidad **sin comillas**, o sobre una sola palabra | `asthma control[tiab:~2]` y `"asthma"[tiab:~2]`: proximidad ignorada sin aviso | la misma regla |
| Mutación superviviente: quitar `NOT` del detector de grupos | `(asthma NOT copd)[tiab]` = 223.754, frente a 184.029 bien escrita | fixture real y prueba; mutación Q8-NOT |
| Mutación superviviente: bajar el mínimo de la clave de 32 a 8 | — | prueba de frontera 31/32; mutación W-CLAVE-31 |

Los 28 usos de proximidad de los filtros del repo cumplen la regla (R16 sigue en verde).

**Siguen parciales y se declaran, no se arreglan aquí:**

- D13: no hay cuota por persona.
- D14: el espaciado entre llamadas a NCBI es por instancia, no global.

Las dos cosas exigen estado compartido (Durable Objects o KV), y el diseño evita ese estado a propósito para no tener nada que mantener. La mitigación es la guía: un piloto pequeño, sin clave NCBI personal y con una clave de acceso por persona.

**Lo único que sigue sin probar:** el Worker en Cloudflare y su conexión desde claude.ai o ChatGPT.

---

## A. Resumen ejecutivo

**Diagnóstico.** El router 1.8 identificó bien el fallo del incidente: la capa intermedia ejecutaba PubMed de verdad pero no devolvía su diagnóstico. **La hipótesis de partida sobrevive** (§32), con dos correcciones:

1. **El diagnóstico parcial vale lo mismo que no tener diagnóstico.** Lo he reproducido: con solo `querytranslation`, un MeSH inventado da un 0 indistinguible de un cero legítimo, y cuando PubMed descarta todos los términos la traducción devuelve la cadena enviada tal cual. Comparar traducción contra consulta diría entonces «nada descartado». Un diagnóstico parcial puede **refutar** la integridad, pero nunca **verificarla**.
2. **El fallo más grave encontrado hoy no es de diagnóstico, es de recuento.** El conector PubMed de este entorno devuelve `total_count: 0` y `has_more: false` para `asthma[tiab]` (195.437 registros) en cuanto `retstart ≥ 9999`. Dónde está esa frontera es secundario (ver §0bis); el defecto es convertir el rechazo en un cero plausible: el `parseInt(count) || 0` que el contrato ya prohíbe, ahora observado en vivo.

**Riesgos principales.** Adaptadores que transforman la consulta en silencio:
- BioMCP elimina `OR`/`AND` como *stopwords* y convierte `A OR B` en `A B`.
- cyanheads codifica `&`, `<` y `>` como entidades HTML.

A eso se suman límites previos al envío (el conector del entorno admite 2.048 caracteres, 20 operadores y 5 comodines) que invitan a «arreglar» filtros curados.

**Arquitectura preferida:** **opción A mínima + híbrida diferida**. El ejecutor canónico es el propio código del repositorio, expuesto ahora como CLI con recibo (`scripts/pubmed-exact.mjs`). Un MCP fino encima solo cuando haga falta servirlo a superficies sin shell. Europe PMC, OpenAlex y Semantic Scholar son *lanes* suplementarios con procedencia propia.

**Cambios hechos en la rama (revisables, cada uno en su commit):**
1. Recuento estricto en la implementación de referencia, sin cambio de contrato.
2. Ejecutor de referencia con recibo de búsqueda.
3. Contrato **1.9.0**, con un único cambio que una prueba exige: el valor `failed` en `operational_status`.

**Diferido:**
- Contrato: vector de ventana de paginación, regla de partición y la frase sobre `NotIndexed`.
- MCP.
- *Lanes* suplementarios.
- Mirror FTP.

---

## B. Hechos reproducidos

Leyenda:
- **REPRODUCIDO**: ejecutado hoy.
- **DOCUMENTADO**: fuente o código leído, sin ejecutar.
- **INFERIDO**: razonado a partir de lo anterior.
- **NO REPRODUCIDO**: no se pudo probar.

| # | Hallazgo | Prueba | Resultado | Fuente | Confianza |
|---|---|---|---|---|---|
| B1 | El conector del entorno no expone `warninglist`/`errorlist`/`ERROR`; sí `query_translation` | `hypertension[tiab] OR "qwertyuiopasdfgh"[tiab]` | 545.657 registros; traducción `"hypertension"[Title/Abstract]`; ningún campo de aviso | conector PubMed, 2026-10-08 | REPRODUCIDO |
| B2 | Con solo traducción, un MeSH inventado da un cero indistinguible de uno legítimo | `"Atherosclerotic Cardiovascular Disease"[Mesh]` frente a `"Atherosclerosis"[Mesh] AND 1804[dp]` | ambos `total_count: 0`, ningún aviso; la primera traducción repite la cadena | conector | REPRODUCIDO |
| B3 | Término descartado con resultados: solo se ve comparando traducción y consulta | consulta *wearables* / `"body battery"` | 6 registros (eran 5 el 09/2026); `"body battery"` ausente de la traducción, sin aviso | conector | REPRODUCIDO |
| B4 | Si se descartan **todos** los términos, la traducción es eco literal de lo enviado | `asthma[tiab] AND ("x0 x0…"[tiab] OR … 15 frases)` | 0; `query_translation` idéntica byte a byte a la consulta (con `[tiab]` sin normalizar) | conector | REPRODUCIDO |
| B5 | Campo inválido: ATM sin aviso visible | `asthma[foo]` | 246.020; traducción por ATM; ningún aviso | conector | REPRODUCIDO (si ESearch emite aviso: NO REPRODUCIDO) |
| B6 | Límites previos al envío del conector | consultas sintéticas y compuestas | rechazo explícito `INVALID_QUERY`: **2.048 caracteres**, **20 operadores** (`AND`/`OR`/`NOT`; `\|` no cuenta), **5 comodines**, `max_results` ≤ 200 | conector | REPRODUCIDO |
| B7 | El filtro de síntesis compuesto (1.942 caracteres) no se puede ejecutar en el conector | `(asthma[tiab]) AND (<metaanalysis.txt>)` | rechazado por 39 comodines | conector | REPRODUCIDO |
| B8 | 12 de 31 filtros del registry no caben en el conector, compuestos con un tema simple | cálculo sobre los filtros y prueba con `geriatrics_specific` (28 `\|`, aceptado) | 19/31 caben; quedan fuera, entre otros, `evidence_synthesis`, `guidelines`, `humans`, `adults` y `pediatrics` | repo + conector | REPRODUCIDO |
| B9 | **Cero falso por paginación** | `asthma[tiab]`, `retstart` 9990 / 9998 / 9999 / 10000 | 9990 → 195.437; 9998 → 1 registro aunque se pidan 2 o 3; 9999 y 10000 → `total_count: 0`, `has_more: false`, traducción sin normalizar. Frontera observable: 9.999 registros (la documentación de NCBI habla de 10.000; ver §0bis) | conector | REPRODUCIDO |
| B10 | El conector no expone MeSH, `Status` ni `IndexingMethod` | `get_article_metadata` PMID 41626901 | sin esos campos | conector | REPRODUCIDO |
| B11 | Los «artículos relacionados» del conector no traen `neighbor_score` e ignoran el límite | PMID 41626901, `max_results: 5` | 100 PMIDs sin puntuación | conector | REPRODUCIDO |
| B12 | La documentación del conector dice «no usar `*`», pero acepta hasta 5 | `wearable*[tiab]` | ejecutado | conector | REPRODUCIDO |
| B13 | Las comillas tipográficas de `geriatrics_especifico.txt` se normalizan bien | traducción de la consulta compuesta | `“mini-mental state”` → `"mini-mental state"[Title/Abstract]` | conector | REPRODUCIDO (no es un defecto) |
| B14 | La implementación de referencia aceptaba recuentos no decimales | `inspectResponse({count:'0x10'})` | `countIsValid: true` (= 16); también `1e3`, `12.0`, `+5` y `-0` | repo @43054b1 | REPRODUCIDO → corregido |
| B15 | cyanheads sigue con `parseInt(Count,10) \|\| 0` | lectura de `src/services/ncbi/ncbi-service.ts:333` | presente, también para `RetMax`/`RetStart` | cyanheads @`5a417fb` (2026-10-04, v2.10.20) | DOCUMENTADO |
| B16 | cyanheads no devuelve `querytranslation` ni las listas crudas | esquema de `search-articles.tool.ts` | expone `effectiveQuery` («consulta saneada enviada») y un `notice` en prosa; `PhrasesIgnored` no está tipado | cyanheads @`5a417fb` | DOCUMENTADO |
| B17 | **cyanheads altera bytes de la consulta** | `sanitize-html` 2.18.0 con la configuración de `sanitizeString(…,'text')` de mcp-ts-core 0.13.13 | `"AT&T"` → `"AT&amp;T"`, `<30` → `&lt;30`, etiquetas eliminadas; afecta a 1 filtro del repo (`clinical/simulation_clinical.txt`, `"BMJ Simulation & Technology Enhanced Learning"`) | ejecución local de la librería | REPRODUCIDO (efecto en PubMed: INFERIDO) |
| B18 | cyanheads pasa a POST por encima de 2.000 caracteres codificados y limita el offset a 9.998 | `api-client.ts:14`, descripción del offset | sí | cyanheads | DOCUMENTADO |
| B19 | **BioMCP convierte `OR` en AND implícito** | port literal de `strip_pubmed_stopwords` (`query.rs:188`) | `A[tiab] OR B[tiab]` → `A[tiab] B[tiab]`; `Therapy/Broad[filter]` → `Therapy Broad[filter]`; `"quality of life"` → `"quality life"` | BioMCP @`8530aab` (2026-10-08) | REPRODUCIDO (port) / DOCUMENTADO (código) |
| B20 | BioMCP: siempre GET, `term` ≤ 4.096, recuento estricto y ningún diagnóstico | `sources/pubmed.rs` | `RequestPlan::get`; `ESearchInner{count, idlist}`; `parse::<u64>` | BioMCP | DOCUMENTADO |
| B21 | El *ledger* de semantic-scholar-mcp bifurca con escritores concurrentes y por defecto se traga los fallos de registro | `ledger.py` (docstring) | «six processes writing 150 lines … produced 14 forks»; `MCP_RECEIPT_STRICT` desactivado por defecto | s2-mcp @`34442d2` | DOCUMENTADO |
| B22 | NLM 2027: `IndexingMethod="NotIndexed"` y FTP con el nuevo proceso | búsqueda web (resumen de la página oficial) | citas en ámbito MEDLINE sin abstract → sin MeSH; en el YEP de diciembre de 2026 pasan de In Process a MEDLINE con `NotIndexed`; se reindexan si llega el abstract; el DTD no cambia | <https://www.nlm.nih.gov/pubs/techbull/so26/so26_pubmed_2027_baseline.html> | DOCUMENTADO (fuente secundaria de la primaria) |
| B23 | Linked Discoveries: piloto lanzado el 2026-09-24, sin API pública localizada | búsqueda web | ~29 M publicaciones; BiomedBERT según la prensa; botón en la página del abstract | <https://www.nlm.nih.gov/pubs/techbull/so26/so26_pubmed_ld.html>, nota de prensa NIH | DOCUMENTADO |
| B24 | Citation searching automatizado: mejor precisión y F1, peor recall y F3 | abstract leído en PubMed | según PubMed: 27 RS, OpenAlex y Semantic Scholar; mejor como suplemento cuando importa el recall | Rajit et al., *Res Synth Methods* 2025, PMID 41626901, [DOI](https://doi.org/10.1017/rsm.2024.15) | REPRODUCIDO (lectura) |
| B25 | OpenAlex: clave obligatoria desde 02/2026, presupuesto gratuito de 1 $/día | búsqueda web | ~1.000 búsquedas o 10.000 listados al día; búsquedas por ID gratuitas; snapshot CC0 | help.openalex.org/access/pricing y terceros | DOCUMENTADO (cifras discrepantes entre fuentes) |
| B26 | OQL: frase exacta frente a *stemmed*, comodines entre comillas, proximidad `~N` | búsqueda web | sí; el muestreo con *seed* no está confirmado | help.openalex.org | DOCUMENTADO |
| B27 | API de Lens por suscripción institucional; individuos revisados caso a caso | búsqueda web | sin plan individual gratuito confirmado | docs.api.lens.org | DOCUMENTADO |
| B28 | Sider: GET y 414 desde ~4.000 caracteres | — | — | antecedente del prompt y del router («414 at 2,925») | NO REPRODUCIDO |
| B29 | PubMed nativa de ChatGPT: límite de 500 caracteres | — | — | antecedente | NO REPRODUCIDO |
| B30 | Barrida live de los 122 filtros | `sweep-filters.mjs` | no ejecutable (403) | — | NO REPRODUCIDO |

---

## C. Auditoría del router (1.8.0 → 1.9.0) por sección

| Sección | Veredicto | Nota |
|---|---|---|
| `rule_classification` | correcto | La dependencia en una dirección y la clasificación única (C1) funcionan. |
| `conformance` | correcto, ampliado | Se añade `reference_executor`. `minimum_query_vectors` mezcla reglas con nombres de campo (`esearchresult.ERROR`); es legible pero heterogéneo. No se cambia. |
| `surface_policy_not_owned_here` | **frágil (menor)** | `removed_in_this_version` es un nombre relativo al tiempo: con 1.9.0 ya no es verdad que se quitaran «en esta versión». Candidato a `removed_in: "1.8.0"` en la próxima versión que toque esa sección. |
| `principles` | correcto | `no_silent_substitution` es exactamente el principio que BioMCP (B19) y cyanheads (B17) violarían como ejecutores. |
| `layers` / `pipeline` | correcto | |
| `defaults` / `routing` / `evidence_landscape_policy` | correcto | Fuera del alcance mecánico. |
| `filter_registry` | correcto | 31 entradas que resuelven (R1/R2). |
| `filter_file_contract` | correcto | |
| `query_execution_contract` | **correcto y suficiente** | Cada fallo observado hoy cae bajo una regla ya escrita: B9 y B15 bajo `count_must_be_a_count`; B1–B4 y B16 bajo `diagnostics_come_from_the_response`; B6, B7 y B20 bajo `transport_carries_the_whole_query` («a rejected … request is a declared transport failure … never silently retried with a shortened query»). **No hace falta ninguna regla nueva.** |
| `registry_validation` | correcto | Sigue vigente; sin barrida live no puedo actualizarlo. |
| `composition` | correcto; **insuficiente** para partición | No dice nada de trocear consultas (§17). Ver §G, diferidos. |
| `provenance` | **insuficiente → cambiado** | `operational_status` no tenía valor para «comprobado y roto». Ver §G. |
| `degradation` | correcto | `literal_pubmed_unavailable` cubre el caso del conector cuando el filtro no cabe. |
| `tool_requirements` | correcto | `identifier_retrieval` ya separa «related articles» de cobertura (B11). |
| `surface_profiles` | **correcto**, con una aclaración útil | El perfil `conversational_surface_with_unverifiable_pubmed` describe «no devuelve querytranslation, warninglist y errorlist». Un motor que devuelve solo la traducción (B1) encaja ahí, porque le falta `execution_diagnostics`. B2 y B4 demuestran que esa clasificación es la correcta y que no hace falta un perfil «parcial» (§16). |
| `candidate_extensions`, `sources`, `adaptation`, etc. | correcto | |

---

## D. Matriz de adaptadores PubMed

Criterios críticos del §25 en negrita. ✔ cumple · ✘ no cumple · ~ parcial · ? no probado.

| Criterio | Ejecutor propio (`esearch.mjs` + `pubmed-exact.mjs`) | Conector PubMed del entorno | Sider | cyanheads @5a417fb | BioMCP @8530aab |
|---|---|---|---|---|---|
| **Fidelidad literal** | ✔ (T1, E1: lo enviado = lo recibido, con hash) | ✔ en lo probado | ? | **✘** entidades HTML (B17) | **✘✘** quita OR/AND y parte por `/` (B19) |
| **Diagnóstico completo** | ✔ crudo, tal como llega | ~ solo traducción (B1–B4) | ✘ (antecedente) | ✘ `notice` en prosa, sin `querytranslation` (B16) | ✘ nada (B20) |
| **POST / consulta larga** | ✔ siempre POST (T1) | ✘ rechazo a 2.048 caracteres, 20 operadores y 5 comodines (B6) | ✘ 414 (antecedente) | ✔ POST >2.000 (B18) | ✘ GET, ≤4.096 |
| **Recuento estricto** | ✔ (Q7 con 16 casos, E3) | **✘ cero falso por paginación** (B9) | ? | ✘ `parseInt‖0` (B15) | ✔ `u64` |
| Respuesta cruda / hash | ✔ sha256 del cuerpo | ✘ | ✘ | ✘ | ✘ |
| Procedencia | ✔ recibo + run (commit, router) | ~ | ✘ | ~ (`searchUrl`) | ~ |
| PMIDs / paginación | ~ primera ventana; lo declara (E4) | ✘ (B9) | ? | ✔ offset ≤ 9.998, declarado | ~ |
| Tests | ✔ suite + mutación | ? | ? | ✔ extensos, pero no los vectores del router | ✔ propios |
| Mantenimiento | propio (~200 líneas, sin dependencias) | proveedor | proveedor | activo | muy activo |
| Superficie de ataque | mínima | — | — | media (dependencias npm, HTTP) | grande |
| Límite de ritmo / reintentos | ✘ en el ejecutor (sí en sweep) | — | — | ✔ | ✔ |
| EFetch / abstract | ✘ (fuera de alcance) | ✔ | ✔ | ✔ | ✔ |
| **¿Ejecutor canónico?** | **Sí** | No (pasa a unverifiable) | No | No sin parche | **No** (solo descubrimiento) |

**Parche mínimo para que cyanheads fuera conforme** (estimación por lectura): recuento estricto (~3 líneas); exponer `queryTranslation`, `errorList` y `warningList` crudos en el `enrichment` (~15 líneas más esquema); tipar `PhrasesIgnored`; no sanear `query` (o rechazar en vez de transformar), que upstream verá como una decisión de seguridad; más tests: ~60–120 líneas. Es razonable como **PR upstream**. Como **fork propio** no compensa: añade una dependencia de ritmo ajeno para obtener lo que el ejecutor propio ya hace en 200 líneas.

---

## E. Matriz de fuentes suplementarias

| Fuente | Función que cubre bien | Acceso (consultado el 2026-10-08) | Papel | Advertencias |
|---|---|---|---|---|
| **NCBI ELink / Similar Articles** | vecinos y enlaces citado/citante dentro de NCBI | E-utilities, gratuito; clave = cuota | **citation/semantic lane nativo**, primer candidato | El conector del entorno no da `neighbor_score` (B11): usar ELink directo con `cmd=neighbor_score`. |
| **Europe PMC** | texto completo OA, referencias, citas, preprints, anotaciones | REST gratuito | **lane de triangulación y full text** | Sintaxis propia; nunca como sustituto de ESearch. |
| **Semantic Scholar** | grafo de citas con `contexts`, `intents` e `isInfluential`; recomendaciones | gratuito; clave con cuota introductoria (cifras discrepantes, B25) | **lane de contextos de citación** | No es la clasificación de Scite; sus *intents* (background/method/result) no son apoyo/contradicción. |
| **OpenAlex** | metadatos abiertos, grafo de citas, OQL reproducible | clave obligatoria; 1 $/día gratuito; snapshot CC0 | **discovery / citation lane**; candidato a red de seguridad de recall **pendiente del benchmark** | Volatilidad de abstracts y metadatos (126 → 123 de 131 en el estudio de 2025). |
| **Crossref** | DOI, metadatos, retractaciones/actualizaciones | público, *polite pool* | **identificadores y estado** | No es recuperación clínica. |
| **NLM Linked Discoveries** | vecindario semántico desde una semilla | solo web; sin API localizada | **`manual_exploratory_lane`** | NLM lo declara experimental. |
| **Inciteful** | Paper Discovery / Literature Connector | web gratuita; sin API localizada | **manual_discovery** | Revisado en ISTL 2026; útil para humanos. |
| **ResearchRabbit** | colecciones y redes | freemium desde 11/2025; 50 semillas por colección | **manual_discovery** | La popularidad no es cobertura. |
| **citationchaser** | chasing hacia delante y hacia atrás para síntesis | Shiny gratuita; el paquete R depende de Lens (institucional) | **manual_discovery** (Shiny) | No como dependencia programática. |
| **Connected Papers** | grafo de un paper | 5 grafos al mes gratis | ocasional, manual | No automatizable. |

**Sustitución funcional de Scite:**

| Función de Scite | Alternativa |
|---|---|
| búsqueda auditable | PubMed ESearch (ejecutor propio) |
| chasing | ELink + Europe PMC + OpenAlex/S2 |
| contexto de cita | Semantic Scholar `contexts` |
| «¿apoya o contradice?» | **no hay reemplazo gratuito equivalente** |

Construir un clasificador LLM sobre los contextos de S2 es posible con las condiciones del §20: fragmento guardado, `unclear`, etiqueta inferida, lectura primaria para lo importante. **Mi recomendación: no construirlo todavía.** No hay una pregunta del router que hoy lo necesite, y su salida tentaría a usarlo como señal de calidad.

---

## F. Impacto NLM 2027

| Ámbito | Impacto en este repositorio | Acción |
|---|---|---|
| **Parser** | **Ninguno directo.** El repositorio no parsea XML de PubMed. cyanheads y BioMCP tampoco leen `IndexingMethod` (grep vacío), así que no hay enum cerrado que rompa. | Ninguna. Si algún día se parsea, el vector V15 debe aceptar valores desconocidos. |
| **Recuperación** | **El cambio reetiqueta el estado, no quita MeSH a nadie.** Esas citas ya no tenían MeSH estando In Process; ahora pasarán a llamarse MEDLINE. Solo se rompen las estrategias que usan el **estado** como proxy de indexación: `medline[sb]` como «indexado», o el patrón `MeSH OR (tiab AND (inprocess[sb] OR pubmednotmedline[sb]))`, que tras diciembre **dejará de recoger** estas citas. | **Ningún filtro del repositorio usa subconjuntos de estado** (solo `systematic[sb]`, 3 veces). Regla añadida en 1.9.0 (`composition.indexing_status_is_not_mesh`) y comprobación R15; ver §0bis. |
| **MeSH** | Refuerza lo que Cochrane ya pide: vocabulario controlado **y** texto libre en búsquedas sensibles. `humans` y `adults` son exclusiones `NOT`, así que **conservan** los registros sin indexar, por diseño. Un `X[mh]` como único canal de un concepto sí los pierde. | Hacer visible esa dependencia, no abandonar MeSH (objeción 6). |
| **FTP** | Alineación FTP = web = API. Útil para *fixtures* y regresión offline. | Experimental (fase 5). |
| **Tests** | Un vector de fixture `Status="MEDLINE" IndexingMethod="NotIndexed"` sin MeSH solo tiene sentido si existe un parser XML. | Diferido. No fabrico fixtures sin los datos beta oficiales. |

¿Hace falta consumir el campo en tiempo de ejecución? **No.** Basta proteger la estrategia: que una pasada sensible no dependa solo de `[mh]` ni de `[sb]` de estado, y que se declare cuando lo haga deliberadamente.

---

## G. Propuesta de contrato

### Implementado en la rama: 1.9.0, un único cambio de contrato

**Prueba que lo exige (E2).** Se alimenta el ejecutor con las respuestas reales de `fixtures/`. Hay que distinguir tres casos, y con `verified | planned | unsupported` solo caben dos:
- `consulta-valida`: diagnóstico limpio;
- `mesh-inexistente` y `termino-descartado-con-resultados`: diagnóstico que **muestra** la consulta rota;
- `aviso-perdido-por-rettype-count`: sin diagnóstico.

Llamar `unsupported` al término descartado esconde un defecto **conocido** detrás de un **desconocido**, que es justo la confusión que el §16 pide evitar.

**Rutas JSON tocadas:**

- `schema_version`, `metadata.version`, `conformance.contract_version` → `1.9.0`
- `provenance.operational_status.semantic_values`: `+ "failed"`
- `provenance.operational_status.value_meanings` (nuevo): define `verified`, `failed`, `planned` y `unsupported`
- `conformance.reference_executor` (nuevo): `scripts/pubmed-exact.mjs`

**Antes / después:**
- **Antes:** una pasada con diagnóstico que muestra un descarte no tiene valor propio.
- **Después:** `failed`.

**Compatibilidad.** Es un cambio aditivo en un enum. Un consumidor que haga `switch` exhaustivo sobre tres valores necesita una rama nueva. Por eso es *minor* y no *patch*.

**Migración.** Las pasadas antiguas registradas como `unsupported` con un descarte visible en sus problemas pueden reetiquetarse como `failed`; nada obliga a hacerlo.

**Tests:** E2 (mapeo); C6 (cada valor existe y está definido); mutación E-COLAPSO, que devuelve `failed` → `unsupported` y debe tumbar E2.

**Riesgo de regresión:** bajo. Ninguna otra sección lee ese enum.

**Commits:**
- `9d3fe40`: recuento estricto, **sin** cambio de contrato.
- `06a7281`: ejecutor + 1.9.0.

Se pueden revertir por separado. Si prefieres no subir el contrato, revertir `06a7281` deja la corrección del recuento intacta.

### Diferido: propuesto, no implementado (cada uno necesita una prueba que hoy falle)

1. **Ventana de paginación** como vector de conformidad (`pagination_window`): «más allá del retstart servible, la respuesta no es un recuento». B9 lo observó en un adaptador ajeno, pero el ejecutor de referencia no pagina, así que hoy ninguna prueba del repositorio falla. Entra cuando haya un adaptador candidato al que pasarle la batería.
2. **Partición de consultas** (`composition.partition`), si alguna superficie la usa. Sustancia:
   - solo por el árbol booleano;
   - la unión de PMIDs solo para bloques OR;
   - **intersección** para bloques NOT: `T NOT (X OR Y) = (T NOT X) ∩ (T NOT Y)`, no la unión;
   - nunca sumar recuentos;
   - registrar cada subconsulta.

   Advertencia medida hoy: con el conector del entorno, la partición exige recuperar **todos** los PMIDs de cada trozo, y el conector sirve 200 por llamada y nada más allá de la primera ventana (9.999 observados). Para temas grandes la partición es **inviable**, no solo arriesgada. Preferencia confirmada: POST directo.
3. ~~`NotIndexed`~~ **Adelantado a 1.9.0** tras la revisión externa: ver §0bis.
4. **`removed_in_this_version`** → `removed_in` con versión explícita.

### Lo que NO entra en el router

Límites concretos de adaptadores (2.048, 20, 5, 4.096, el 414 de Sider…). Cambian sin aviso y el router no puede verificarlos. Viven en este informe con fecha; si un día se automatiza su medición, en un sidecar generado por tests (§15), nunca escrito a mano.

---

## H. Propuesta de adaptador: el ejecutor de referencia y su recibo

Implementado como `scripts/pubmed-exact.mjs`. Usa Node ≥ 18 y no tiene dependencias. Por qué CLI y no MCP: **toda superficie con shell y red (Claude Code, Codex, scripts) ya puede ejecutarlo**. Un MCP solo aporta para superficies conversacionales sin shell, y trae hosting, autenticación y superficie de ataque. Va en la fase 1b, envolviendo este mismo `runExact()`.

Recibo (`stdout`, una pasada):

```json
{
  "run": { "contract_version": "1.9.0", "repository": "ernestobarrera/pubmed-filters",
           "repository_commit": "…", "repository_dirty": false, "router_sha256": "…" },
  "executed_at": "2026-10-08T10:00:00.000Z",
  "engine": "scripts/pubmed-exact.mjs",
  "endpoint": "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
  "sent_query": "…", "sent_query_sha256": "…",
  "transport": "POST",
  "request": { "retstart": 0, "retmax": 200, "api_key_used": true },
  "result_count": 123, "count_raw": "123",
  "records_retrieved": 123, "records_complete": true, "window_limit": null,
  "pmids": ["…"], "pmid_list_sha256": "…",
  "querytranslation": "…", "warninglist": { }, "errorlist": null, "fatal_error": null,
  "raw_response_sha256": "…",
  "status": { "query_integrity": "verified" },
  "problems": []
}
```

Decisiones:
- `result_count` es `null`, nunca 0, si el recuento no es un recuento.
- `count_raw` se conserva siempre.
- El hash es del **cuerpo crudo**, no del JSON re-serializado (mutación E-REHASH).
- La clave de API nunca se escribe.
- No hay `coverage` ni `reading_depth`: el ejecutor no lee ni decide cobertura, y no declara lo que no hace.

Códigos de salida:
- 0 = `verified`;
- 1 = `failed` o `unsupported`;
- 2 = error;
- 3 = fallo de transporte (sin recuento).

**Hash encadenado (§23): no.** Las cadenas sin ancla externa se pueden recalcular enteras. El propio autor de semantic-scholar-mcp documenta bifurcaciones con escritores concurrentes y que por defecto se tragan los fallos de registro (B21). Aquí el ancla barata ya existe: un recibo JSON por pasada, guardado junto al trabajo y versionado en git, con hashes de consulta, cuerpo y PMIDs. Si algún día hace falta un JSONL *append-only*, `>> recibos.jsonl` basta.

---

## I. Tests

| ID | Qué protege | Estado |
|---|---|---|
| Q7 (16 casos) | recuento ausente, vacío, null, negativo, `12abc`, espacios, **`0x10`, `1e3`, `12.0`, `+5`, `-0`**, no entero; acepta `"1234"`, `1234` y `"0"` | ampliado, verde |
| E1 | lo registrado es lo enviado (byte a byte y hash), POST, hash del cuerpo crudo, diagnóstico tal como llegó | nuevo, verde |
| E2 | `verified` / `failed` / `unsupported` no se confunden y están en el contrato | nuevo, verde (rojo antes de 1.9.0) |
| E3 | un recuento inservible es `null` en el recibo y nunca `verified` | nuevo, verde |
| E4 | `result_count` ≠ `records_retrieved`; ventana de ESearch declarada; `retmax` fuera de ventana no se envía | nuevo, verde |
| E5 | un 414 en el ejecutor es fallo de transporte, sin recibo con recuento | nuevo, verde |
| C2 / C6 / C12 | el ejecutor existe y está declarado; los valores de estado están definidos; el ejecutor solo habla con ESearch a través de `esearch.mjs` | ampliados, verde |
| Mutaciones M7, E-COERCION, E-COLAPSO, E-REHASH | cada comprobación nueva sabe rechazar la implementación mala que dice vigilar | 15/15 |

**Batería para declarar conforme cualquier adaptador** (§24), mapeada a lo que existe:

| Vector | Cobertura actual |
|---|---|
| V01–V07 | fixtures reales + Q1–Q7 |
| V08 | `mesh-inexistente` |
| V09 | `termino-descartado-con-resultados` |
| V10–V11 | Q7 / E3 |
| V12–V13 | T1 / T2 / E5 |
| V14 (campo inválido) | **pendiente de capturar una respuesta real de ESearch**; no se fabrica |
| V15 (`NotIndexed`) | solo si hay parser XML |
| V16 (paginación) | E4 en el ejecutor propio; para adaptadores ajenos, la prueba B9 (un `retstart` fuera de la ventana no puede dar 0, sea la frontera 9.999 o 10.000) |

**Lo que ningún test sustituye (PRESS, §19):** traducción de la pregunta, conceptos que faltan, adecuación de cada MeSH, si forzar un componente PICO perjudica el recall, si el filtro metodológico encaja con la pregunta. Checklist humano propuesto, que el agente invoca solo cuando la búsqueda sostendrá una afirmación de cobertura:

| Elemento PRESS | Automatizable aquí | Juicio humano |
|---|---|---|
| Traducción de la pregunta | no | ¿Los conceptos son los de la pregunta? ¿Sobra alguno? |
| Booleanos y proximidad | sí: R14, N1–N3, `querytranslation` | ¿Los OR van dentro del concepto y los AND entre conceptos? |
| Encabezados | sí: descarte y `rule_for_headings` | ¿Es el descriptor adecuado, explotado o no? |
| Texto libre | parcial: descartes | ¿Faltan sinónimos o variantes ortográficas? |
| Ortografía y sintaxis | sí: R14, recibo | — |
| Límites y filtros | sí: fechas embebidas, NOT, ventana | ¿El filtro es apropiado para la pregunta? |

---

## J. Riesgos y objeciones

**La objeción más fuerte contra mi propuesta:** *«un CLI no resuelve el incidente».* El incidente ocurrió en una superficie conversacional sin shell, y para esa superficie un CLI no existe. Es cierto, y por eso:
- el CLI es la fase 1, no el final;
- la fase 1b, el MCP fino, es la que cierra el incidente;
- mientras tanto, la regla del router (`handoff` a un motor con diagnóstico) es la única defensa en esas superficies.

Si el uso real es sobre todo conversacional, el orden debería invertirse: **MCP fino primero**, envolviendo `runExact()`, o PR a cyanheads si el autor acepta exponer el diagnóstico crudo.

**Objeción 1** («cyanheads ya hace casi todo»). Hacen falta 4 cambios y uno de ellos, el saneado, es una decisión de seguridad upstream. Como PR, sí: es buena idea proponerlo con B15–B17 como evidencia. Como dependencia canónica hoy, no.

**Objeción 2** («sobrediseñado para práctica clínica»). Es válida para el **radar** y no para la **afirmación de cobertura**. El router ya separa grados de rigor: el perfil sin diagnóstico puede usarse (`still_allowed`) con `counts_as_coverage: false`. Una consulta puntual o un radar pueden correr en el conector del entorno; una afirmación del tipo «no hay ECA sobre X» no.

**Objeción 3** («basta con traducción y un aviso simplificado»). **Refutada con casos reales:**
- B2: cero roto indistinguible de cero legítimo.
- B4: eco literal cuando se descarta todo.
- B9: cero falso por paginación.
- B3: el descarte con resultados solo se detecta parseando y emparejando términos, frágil bajo ATM.

**Objeción 4** («OpenAlex OQL ya reemplaza PubMed»). Sin probar hoy, porque la API está bloqueada. Aunque OQL tenga proximidad y comodines, no tiene MeSH, ni `[pt]`, ni subconjuntos clínicos, ni los filtros validados del repositorio, y sus abstracts son volátiles. Para que lo reemplazara haría falta el benchmark del §21 con un *gold set*. **Hipótesis:** discovery/citation lane y, como mucho, red de seguridad de recall.

**Objeción 5** («grafo + vecinos sustituyen al booleano»). Contradicha por TARCiS y por PMID 41626901: peor recall y F3. Solo como suplemento.

**Objeción 6** («`NotIndexed` obliga a dejar MeSH»). Sobrerreacción. El cambio reetiqueta el estado y no quita MeSH a ningún registro. Ver §F.

**Otros riesgos:**
- `fetch` de Node no usa el proxy de `HTTPS_PROXY` por defecto: en entornos con proxy, el ejecutor falla con «fetch failed». Falla de forma honesta (salida 2, `result_count: null`), pero falla.
- El ejecutor no limita el ritmo: en bucle hay que respetar 3 peticiones/s, o 10 con clave, como ya hace `sweep-filters.mjs`.
- Mantener un ejecutor propio cuesta poco hoy (~200 líneas), pero crecerá si se le añaden EFetch o reintentos. **Regla: no convertirlo en otro BioMCP.**

---

## K. Plan incremental

| Fase | Contenido | Estado | Rollback |
|---|---|---|---|
| 0 | Fixtures y benchmark: abrir red a NCBI/OpenAlex/S2; `sweep-filters.mjs`; capturar V14 real; mini-benchmark OQL (§21) | **pendiente de red** | — |
| 1 | Recuento estricto + ejecutor con recibo + 1.9.0 | **hecho en la rama** | revertir `06a7281` y/o `9d3fe40` |
| 1b | MCP stdio fino sobre `runExact()` (una herramienta, `pubmed_search_exact`), **o** PR a cyanheads con B15–B17 | propuesto | quitar el MCP; el CLI sigue |
| 2 | Sidecar de capacidades **solo si** se genera con tests contra cada adaptador | no recomendado ahora | — |
| 3 | Router: los 4 diferidos del §G, cada uno con su prueba | propuesto | versión *minor* |
| 4 | Lanes suplementarios: ELink con `neighbor_score`, Europe PMC y OpenAlex/S2 para chasing, cada uno con su recibo (semillas, dirección, fecha, iteración, índice, herramienta: TARCiS), activados por la regla de ganancia de información (§22) | propuesto | apagar el lane |
| 5 | Snapshot FTP para regresión y *fixtures* `NotIndexed` desde datos beta oficiales | experimental | borrar el snapshot |

**Regla de parada para los lanes (§22):** tras la pasada PubMed principal, se activa un lane solo si hay una clase de evidencia nueva, un conflicto, una población no cubierta o una seguridad incierta. Se registra qué aportó cada lane. Un PMID nuevo no es, por sí solo, información nueva.

---

## L. Decisión

**CAMBIAR AHORA** (hecho en la rama, pendiente de tu revisión):
- Recuento estricto en `inspectResponse()` (commit `9d3fe40`).
- `scripts/pubmed-exact.mjs` con recibo; `esearch.mjs` devuelve el cuerpo crudo (commit `06a7281`).
- Contrato 1.9.0: `failed` + `value_meanings` + `reference_executor` (commit `06a7281`).
- Abrir la red del entorno a NCBI para correr la barrida y fijar, **si procede**, la base nueva tras clasificar los cambios.

**NO CAMBIAR:**
- `query_execution_contract`: cubre todos los fallos observados.
- `surface_profiles`: no añadir un perfil «parcial»; la traducción sola no verifica.
- Filtros publicados.
- Línea base del sweep (no se pudo medir).
- No meter límites de proveedores en el router.

**EXPERIMENTAR:**
- MCP fino sobre `runExact()`.
- PR a cyanheads.
- Benchmark OQL.
- ELink con `neighbor_score`.
- S2 `contexts` como lane de contexto sin clasificar.
- Snapshot FTP.
- Los 4 diferidos de contrato.

**DESCARTAR:**
- **BioMCP** como ejecutor PubMed (transforma `OR` en AND implícito); sí sirve para enriquecimiento.
- **Sider** y el **conector del entorno** como ejecutores para afirmar cobertura (sin diagnóstico, con límites previos al envío y con cero falso por paginación); sí sirven para radar y lectura por identificador.
- Scite como requisito.
- Hash encadenado.
- Partición por caracteres.
- Clasificador apoyo/contradicción, por ahora.

La recomendación reduce la falsa trazabilidad. Lo único que añade al contrato es un valor que **distingue** un defecto conocido de un desconocido, y lo único que añade al código es una vía que registra lo enviado y lo recibido en lugar de reconstruirlo.

---

## Respuestas breves a las 23 preguntas del §29

1. **Dónde estuvo el fallo:** en la capa intermedia (Sider), que no devolvía el diagnóstico de ESearch.
2. **PubMed o adaptador:** PubMed informa; el fallo era del adaptador. Los límites de 500, 2.048 o 4.096 caracteres, 20 operadores y 5 comodines son de adaptadores, no de PubMed.
3. **Qué avisos se ocultaban:** `quotedphrasesnotfound`, `phrasesignored`, `errorlist.phrasesnotfound`, `outputmessages` y `ERROR`. B2–B4 muestran casos en que solo esos campos lo delatan.
4. **Limitaciones por adaptador:** §D.
5. **¿El ejecutor del repo puede convertirse en MCP?** Sí. `runExact()` es la función que un MCP envolvería, sin tocar el contrato.
6. **¿MCP propio mínimo o parchear cyanheads?** Propio mínimo como canónico; PR a cyanheads como contribución.
7. **Partes del 1.8 ya suficientes:** todo `query_execution_contract`, los perfiles y `provenance` salvo el enum.
8. **Qué justifica una 1.9:** solo `failed`, con la prueba E2.
9. **Qué va a un sidecar:** los límites de adaptadores, y solo si se generan con tests. Si no, al informe con fecha.
10. **Diagnóstico parcial:** como `unverifiable` (perfil existente). Puede refutar la integridad, nunca verificarla.
11. **Consultas largas:** POST directo; partición solo como último recurso y con álgebra (§G).
12. **Qué cambia por `NotIndexed`:** no usar el estado como proxy de indexación; MeSH + texto libre en pasadas sensibles.
13. **¿Consumir el campo en tiempo de ejecución?** No; proteger la estrategia.
14. **¿Mirror FTP?** Solo para regresión y *fixtures*, experimental.
15. **Alternativas a Scite por función:** §E.
16. **Qué no se puede reemplazar:** la etiqueta apoyo/contradicción sin una clasificación propia.
17. **Papeles:** S2 para contexto de citas; Europe PMC para full text, triangulación y preprints; OpenAlex para discovery y chasing (recall pendiente de benchmark).
18. **Linked Discoveries e Inciteful:** lanes manuales y exploratorios.
19. **Cómo se audita el chasing:** con el recibo TARCiS (semillas, dirección, fecha, iteraciones, índice, herramienta).
20. **Tests frente a memoria humana:** §I. PRESS conceptual queda humano.
21. **Que la IA no «arregle» la consulta:** recibo con hash de lo enviado (E1), prohibición de reescritura (`never silently retried with a shortened query`) y adaptadores que transforman descartados como ejecutores.
22. **Diseño de menor deuda:** ejecutor propio sin dependencias y fuentes externas solo como lanes.
23. **Plan sin romper el uso actual:** §K. `quickstart` y `sweep` siguen funcionando igual.
