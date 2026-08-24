# `candidates/` — filtros propuestos y **no validados**

Esta carpeta existe para que un filtro en construcción **sobreviva sin prometer nada**.

## Qué es un candidato

Una estrategia de búsqueda que ya se ha probado contra PubMed y de la que se conocen sus números,
pero que **todavía no se ha validado**: no se ha comprobado su rendimiento contra un conjunto de
referencia, ni se han caracterizado sus falsos positivos, ni se ha decidido si compensa.

## Contrato

- **Un candidato NO se integra** en `buscar-pubmed`, en MedCheck ni en ningún flujo que produzca una
  recomendación clínica. Está aquí precisamente porque aún no se sabe si engaña.
- **Cada fichero declara su estado en su propia cabecera**, con la misma plantilla que el resto del
  repositorio (`# Filtro:` / `# Estado:` / `# Comprobación técnica`). La advertencia viaja **dentro
  del fichero**, no en este readme: quien copia un filtro se lleva el filtro, no la carpeta.
- **Se versiona a propósito.** Un candidato sin trackear desaparece con un `git clean` y con él la
  medición que costó hacerlo. Perder el trabajo es un riesgo mayor que publicarlo declarado, siempre
  que la declaración sea inequívoca y viaje pegada al contenido.
- **Promocionar un candidato** es moverlo a su carpeta temática (`clinical/`, `methodology/`,
  `scope/`, `journals/`) y sustituir `# Estado:` por la validación que lo respalda. Mientras esté
  aquí, no lo está.

## Por qué no basta con dejarlos fuera del repositorio

Un fichero sin trackear no es una decisión, es un olvido con fecha de caducidad: no se recupera
desde otro equipo, no sobrevive a una limpieza y nadie que no estuviera delante sabe que existió.
Esta carpeta convierte ese olvido en un estado declarado y reversible.
