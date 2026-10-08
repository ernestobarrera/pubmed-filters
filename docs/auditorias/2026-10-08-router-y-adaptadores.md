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

## A. Resumen ejecutivo

**Diagnóstico.** El router 1.8 identificó bien el fallo del incidente: la capa intermedia ejecutaba PubMed de verdad pero no devolvía su diagnóstico. **La hipótesis de partida sobrevive** (§32), con dos correcciones:

1. **El diagnóstico parcial vale lo mismo que no tener diagnóstico.** Lo he reproducido: con solo `querytranslation`, un MeSH inventado da un 0 indistinguible de un cero legítimo, y cuando PubMed descarta todos los términos la traducción devuelve la cadena enviada tal cual. Comparar traducción contra consulta diría entonces «nada descartado». Un diagnóstico parcial puede **refutar** la integridad, pero nunca **verificarla**.
2. **El fallo más grave encontrado hoy no es de diagnóstico, es de recuento.** El conector PubMed de este entorno devuelve `total_count: 0` y `has_more: false` para `asthma[tiab]` (195.437 registros) en cuanto `retstart ≥ 9999`. Es un error del backend convertido en cero plausible: el `parseInt(count) || 0` que el contrato ya prohíbe, ahora observado en vivo.

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
| B9 | **Cero falso por paginación** | `asthma[tiab]`, `retstart` 9990 / 9999 / 10000 | 9990 → 195.437; 9999 y 10000 → `total_count: 0`, `has_more: false`, traducción sin normalizar | conector | REPRODUCIDO |
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
| **Recuperación** | **El cambio reetiqueta el estado, no quita MeSH a nadie.** Esas citas ya no tenían MeSH estando In Process; ahora pasarán a llamarse MEDLINE. Solo se rompen las estrategias que usan el **estado** como proxy de indexación: `medline[sb]` como «indexado», o el patrón `MeSH OR (tiab AND (inprocess[sb] OR pubmednotmedline[sb]))`, que tras diciembre **dejará de recoger** estas citas. | **Ningún filtro del repositorio usa subconjuntos de estado** (solo `systematic[sb]`, 3 veces). Recomiendo una frase en `composition.topic_building` en la próxima versión. |
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

   Advertencia medida hoy: con el conector del entorno, la partición exige recuperar **todos** los PMIDs de cada trozo, y el conector sirve 200 por llamada y nada más allá de 9.999. Para temas grandes la partición es **inviable**, no solo arriesgada. Preferencia confirmada: POST directo.
3. **`NotIndexed`**: una frase en `composition.topic_building`: «no uses subconjuntos de estado (`medline[sb]`, `inprocess[sb]`) como proxy de indexación MeSH». Más una comprobación R que falle si un filtro los usa. Hoy pasaría en verde: es una protección de futuro.
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
| V16 (paginación) | E4 en el ejecutor propio; para adaptadores ajenos, la prueba B9 (`retstart=9999` no puede dar 0) |

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
