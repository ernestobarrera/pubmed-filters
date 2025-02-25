# Guía de Contribución

## 🌟 Inicio Rápido

[![Nuevo Filtro](https://img.shields.io/badge/Crear-Nuevo_Filtro-success?style=for-the-badge)](../../issues/new?template=nuevo_filtro.md)
[![Modificar Filtro](https://img.shields.io/badge/Proponer-Modificación-blue?style=for-the-badge)](../../issues/new?template=modificar_filtro.md)

## 📋 Proceso de Contribución

### 1. Preparación

- [ ] Revisa [filtros existentes](../../tree/main/filters) para evitar duplicados
- [ ] Consulta [issues abiertas](../../issues) para ver trabajos en curso
- [ ] Familiarízate con la estructura del repositorio

### 2. Desarrollo

#### Para Nuevos Filtros

1. [Crea una Issue usando la plantilla de Nuevo Filtro](../../issues/new?template=nuevo_filtro.md)
2. Fork y desarrollo:
   ```bash
   git checkout -b filter/nombre-descriptivo
   ```
3. [Crea un Pull Request](../../pulls)

#### Para Modificaciones

1. [Crea una Issue usando la plantilla de Modificación](../../issues/new?template=modificar_filtro.md)
2. Fork y desarrollo:
   ```bash
   git checkout -b update/nombre-filtro
   ```
3. [Crea un Pull Request](../../pulls)

## 📝 Especificaciones Técnicas

### Estructura de Archivos

```
filters/
└── categoría/         # metodologicos, clinicos, poblacion
    └── nombre_filtro[_sensible|_especifico].txt
```

### Formato de Filtros

```yaml
# Filtro: [NOMBRE DEL FILTRO]
# Autor revisión: @ernestobarrera
# Fecha: DD-MM-YYYY
# Descripción: [DESCRIPCIÓN BREVE]
# Referencia: [REFERENCIA BIBLIOGRÁFICA]
# URL: [URL DE LA REFERENCIA]

[CONTENIDO DEL FILTRO]

@@@FILTER_METADATA@@@
{
  "validation": {
    "reference": "[AUTOR ET AL, AÑO]"
  }
}
```

### Nomenclatura

- Minúsculas con guiones bajos
- Sufijos según precisión:
  - `_sensible`: Alta sensibilidad
  - `_especifico`: Alta especificidad

## ✅ Criterios de Validación

### 1. Términos MeSH

- [ ] Verificados en [base MeSH](https://www.nlm.nih.gov/mesh)
- [ ] Actualizados al año en curso

### 2. Métricas

- [ ] Sensibilidad (%)
- [ ] Especificidad (%)
- [ ] Precisión sobre muestra aleatoria
- [ ] Comparativa con filtros similares

### 3. Documentación

- [ ] Comentarios explicativos
- [ ] Referencias bibliográficas
- [ ] Ejemplos de uso

## 🔄 Proceso de Revisión

1. Revisión Inicial

   - [ ] Estructura del archivo
   - [ ] Formato del filtro
   - [ ] Documentación básica

2. Validación Técnica

   - [ ] Términos MeSH correctos
   - [ ] Sintaxis booleana válida
   - [ ] Resultados documentados

3. Aprobación Final
   - [ ] Merge a main
   - [ ] Cierre de issue
   - [ ] Actualización de documentación

## 📚 Recursos

| Recurso          | Descripción              | Enlace                                                  |
| ---------------- | ------------------------ | ------------------------------------------------------- |
| MeSH             | Base de términos médicos | [Acceder](https://www.nlm.nih.gov/mesh/meshhome.html)   |
| PubMed Syntax    | Guía de sintaxis         | [Acceder](https://pubmed.ncbi.nlm.nih.gov/help/#syntax) |
| Clinical Queries | Filtros metodológicos    | [Acceder](https://www.ncbi.nlm.nih.gov/pubmed/clinical) |

## ❓ Soporte

- [Crear issue de consulta](../../issues/new?labels=pregunta)
- [Ver preguntas frecuentes](../../labels/pregunta)

---

### Atajos Rápidos

- 🆕 [Nuevo Filtro](../../issues/new?template=nuevo_filtro.md)
- 🔄 [Modificar Filtro](../../issues/new?template=modificacion_filtros.md  )
- ❓ [Consulta](../../issues/new?template=Blank+issue?labels=pregunta)
- 📊 [Ver Progreso](../../projects)
