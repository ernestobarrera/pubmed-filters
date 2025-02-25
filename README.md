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
