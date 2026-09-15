# 🔍 Filtros PubMed

[![Estado](https://img.shields.io/badge/estado-activo-success.svg)](https://github.com/ernestobarrera/pubmed-filters)
[![Licencia](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)
[![Issues](https://img.shields.io/github/issues/ernestobarrera/pubmed-filters)](https://github.com/ernestobarrera/pubmed-filters/issues)

Colección curada de filtros metodológicos para optimizar búsquedas bibliográficas en PubMed. Este repositorio contiene estrategias de búsqueda validadas que se integran con el [Buscador PubMed Avanzado](https://ernestobarrera.github.io/buscar-pubmed.html).

## 📚 Contenido

El repositorio organiza los filtros en tres categorías principales:

```
filters/
├── methodology/  # Filtros metodológicos
│   ├── mbe.txt
│   ├── gpc.txt
│   └── ...
├── clinical/     # Filtros de enfoque clínico
│   ├── diagnosis_sensible.txt
│   ├── diagnosis_especifico.txt
│   └── ...
└── scope/        # Filtros de ámbito
    ├── primary_sensible.txt
    ├── primary_especifico.txt
    └── ...
```

## 🤖 Uso por agentes

`neurosymbolic_router.json` es la capa de orquestación del repositorio: traduce una intención clínica o científica en un plan de búsqueda componiendo los filtros de `filters/`, sin reconstruir sus booleanos. No es un filtro y no sustituye a ninguno.

Servido en `https://ernestobarrera.github.io/pubmed-filters/neurosymbolic_router.json`.

Reparto de responsabilidades, declarado en `layers` y `pipeline`:

```
INTENCIÓN → FILTRO SIMBÓLICO → BÚSQUEDA → ABSTRACTS/FUENTES → LECTURA CRÍTICA → ÚLTIMA MILLA
\________________ router ________________/  \_________ superficie _________/
```

Cuatro bloques que conviene leer antes de consumirlo, porque evitan errores que no hacen ruido:

- **`filter_file_contract`** — cómo se extrae la consulta de un `.txt`. Tomar solo la primera línea no comentada trunca los filtros multilínea y devuelve recuentos plausibles pero falsos.
- **`composition.negation_filters`** — los filtros que empiezan por `NOT` (`humans`, `adults`, `ocde`) se añaden **sin** `AND`. Componerlos con `AND` invierte el filtro: PubMed traduce `AND (NOT X)` como `AND X` y devuelve justo lo que se quería excluir.
- **`registry_validation`** — qué entradas son de elaboración propia y no están validadas, y por qué las listas de revistas no son filtros validados.
- **`surface_profiles`** — qué secciones aplican según lo que la superficie sepa hacer realmente: ejecutar PubMed literal, leer abstracts, deduplicar por PMID, registrar procedencia. Lo que no pueda hacer se dice, no se simula.

## 🤝 Contribuciones

Damos la bienvenida a contribuciones que mejoren la calidad y utilidad de los filtros.

### Cómo contribuir

1. **Proponer nuevo filtro**:

   - Revisa las [issues abiertas](https://github.com/ernestobarrera/pubmed-filters/issues)
   - Crea una nueva issue usando la plantilla correspondiente
   - Describe el filtro y su validación

2. **Mejorar filtro existente**:
   - Fork del repositorio
   - Crea una rama (`git checkout -b mejora/nombre-filtro`)
   - Realiza tus cambios
   - Envía un Pull Request

### Guías de contribución

Ver [CONTRIBUTING.md](CONTRIBUTING.md) para detalles sobre:

- Estructura de los filtros
- Proceso de validación
- Guías de estilo
- Flujo de trabajo con Git

## 🔧 Uso

Los filtros se integran automáticamente en el [Buscador PubMed Avanzado](https://ernestobarrera.github.io/buscadores-pubmed.html), pero también pueden usarse directamente en PubMed:

1. Selecciona el filtro deseado
2. Copia el contenido
3. Pega en el builder avanzado de PubMed
4. Combina con tus términos de búsqueda

## 📊 Validación

Cada filtro incluye:

- Términos MeSH validados
- Operadores booleanos optimizados
- Pruebas de rendimiento
- Referencias cuando aplica

## 🌟 Recursos

- [Base de datos MeSH](https://www.ncbi.nlm.nih.gov/mesh)
- [Búsqueda avanzada PubMed](https://pubmed.ncbi.nlm.nih.gov/advanced/)
- [Tutorial PubMed](https://www.nlm.nih.gov/bsd/disted/pubmedtutorial/cover.html)

## 📄 Licencia

Este proyecto está bajo la Licencia MIT - ver el archivo [LICENSE](LICENSE) para detalles.

## ✨ Reconocimientos

- Contribuidores de la comunidad
- National Library of Medicine
- PubMed Clinical Queries

---

Desarrollado y mantenido por [@ernestob](https://github.com/ernestobarrera)
