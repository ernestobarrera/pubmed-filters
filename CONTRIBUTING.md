# Guía de Contribución

## 🌟 Antes de Empezar

1. **Revisa los filtros existentes** para evitar duplicados
2. **Consulta las issues abiertas** para ver si alguien ya está trabajando en algo similar
3. **Familiarízate con la estructura** del repositorio

## 📋 Proceso de Contribución

### Para Nuevos Filtros

1. **Crea una Issue**

   - Usa la plantilla "Nuevo Filtro"
   - Describe claramente el propósito
   - Incluye validación inicial

2. **Fork y Desarrollo**

   - Fork del repositorio
   - Crea rama: `filter/nombre-descriptivo`
   - Añade el filtro siguiendo las guías

3. **Pull Request**
   - Referencia la issue (#número)
   - Completa la plantilla
   - Espera revisión

### Para Modificaciones

1. **Crea una Issue**

   - Usa la plantilla "Modificación"
   - Explica los cambios
   - Muestra comparativas

2. **Desarrollo**

   - Fork del repositorio
   - Crea rama: `update/nombre-filtro`
   - Realiza cambios

3. **Pull Request**
   - Incluye antes/después
   - Documenta validación
   - Espera revisión

## 📝 Guías de Estilo

### Estructura de Archivos

```
filters/
└── categoría/
    └── nombre_filtro[_sensible|_especifico].txt
```

### Formato de Filtros

```
# Filtro: [NOMBRE DEL FILTRO]
# Autor revisión: @ernestobarrera
# Fecha: DD-MM-YYYY
# Descripción: [DESCRIPCIÓN BREVE DEL FILTRO Y SU PROPÓSITO]
# Referencia completa: [REFERENCIA BIBLIOGRÁFICA COMPLETA INCLUYENDO MODIFICACIONES SI LAS HAY]
# URL: [URL DE LA REFERENCIA SI EXISTE]


[CONTENIDO DEL FILTRO]

@@@FILTER_METADATA@@@
{
  "validation": {
    "reference": "[AUTOR ET AL, TÍTULO ABREVIADO. AÑO]"
  }
}
```

### Nomenclatura

- Usar minúsculas
- Separar palabras con guiones bajos
- Sufijos `_sensible` o `_especifico` cuando aplique

## ✅ Validación

### Requisitos Mínimos Sugeridos

1. **Términos MeSH**

   - Verificados en la base MeSH
   - Actualizados al año en curso

2. **Pruebas**

   - Número de resultados
   - Precisión (muestra aleatoria)
   - Comparativa con filtros similares

3. **Documentación**
   - Comentarios en el código
   - Referencias si aplica
   - Ejemplos de uso

## 🔄 Proceso de Revisión

1. **Revisión Inicial**

   - Estructura correcta
   - Guías de estilo
   - Documentación básica

2. **Validación Técnica**

   - Términos MeSH
   - Operadores booleanos
   - Resultados de pruebas

3. **Aprobación Final**
   - Merge a main
   - Cierre de issue
   - Actualización de docs

## 📚 Recursos Útiles

- [Guía MeSH](https://www.nlm.nih.gov/mesh/meshhome.html)
- [Sintaxis PubMed](https://pubmed.ncbi.nlm.nih.gov/help/#syntax)
- [Clinical Queries](https://www.ncbi.nlm.nih.gov/pubmed/clinical)

## ❓ ¿Preguntas?

Abre una issue con la etiqueta "pregunta" o contacta con los mantenedores.

---

¡Gracias por contribuir! 🎉
