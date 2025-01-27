Actualizaré la documentación con todos los nuevos elementos que hemos discutido:

# Documentación de Filtros PubMed

## Estructura del Archivo

Cada archivo de filtro debe seguir una estructura específica con dos partes principales:

### 1. Cabecera de Documentación

```plaintext
# Filtro: [NOMBRE DEL FILTRO]
# Autor revisión: @ernestobarrera
# Fecha: DD-MM-YYYY
# Descripción: [DESCRIPCIÓN BREVE DEL FILTRO Y SU PROPÓSITO]
# Referencia completa: [REFERENCIA BIBLIOGRÁFICA COMPLETA INCLUYENDO MODIFICACIONES SI LAS HAY]
# URL: [URL DE LA REFERENCIA SI EXISTE]
```

#### Normas para la Cabecera:

- Usar el formato de fecha español (DD-MM-YYYY)
- Incluir una descripción clara del propósito del filtro
- La referencia completa debe incluir cualquier modificación realizada
- La URL es opcional

### 2. Filtro y Metadata

Existen tres plantillas principales según el tipo de filtro:

#### 2.1 Filtro Simple con Métricas:

```plaintext
[CONTENIDO DEL FILTRO]

@@@FILTER_METADATA@@@
{
  "validation": {
    "metrics": {
      "sensitivity": 00.0,
      "specificity": 00.0,
      "precision": 00.0
    },
    "reference": "[AUTOR ET AL, TÍTULO ABREVIADO. AÑO]"
  }
}
```

#### 2.2 Filtro con Versiones Sensible/Específica:

```plaintext
[CONTENIDO DEL FILTRO]

@@@FILTER_METADATA@@@
{
  "validation": {
    "metrics": {
      "sensitive": {
        "sensitivity": 00.0,
        "specificity": 00.0,
        "precision": 00.0
      },
      "specific": {
        "sensitivity": 00.0,
        "specificity": 00.0,
        "precision": 00.0
      }
    },
    "reference": "[AUTOR ET AL, TÍTULO ABREVIADO. AÑO]"
  }
}
```

#### 2.3 Filtro Sin Métricas:

```plaintext
[CONTENIDO DEL FILTRO]

@@@FILTER_METADATA@@@
{
  "validation": {
    "reference": "[AUTOR ET AL, TÍTULO ABREVIADO. AÑO]"
  }
}
```

## Gestión de Tooltips

### Función de Formateo:

```javascript
function formatTooltipContent(metadata) {
  const parts = [];

  if (metadata.validation?.metrics) {
    // Para filtros con versión única
    if ("sensitivity" in metadata.validation.metrics) {
      parts.push(`S: ${metadata.validation.metrics.sensitivity}%`);
      parts.push(`E: ${metadata.validation.metrics.specificity}%`);
      if ("precision" in metadata.validation.metrics) {
        parts.push(`P: ${metadata.validation.metrics.precision}%`);
      }
    }
    // Para filtros con versiones sensible/específica
    else if ("sensitive" in metadata.validation.metrics) {
      parts.push("Versión Sensible:");
      parts.push(`S: ${metadata.validation.metrics.sensitive.sensitivity}%`);
      parts.push(`E: ${metadata.validation.metrics.sensitive.specificity}%`);
      if ("precision" in metadata.validation.metrics.sensitive) {
        parts.push(`P: ${metadata.validation.metrics.sensitive.precision}%`);
      }
      parts.push("\nVersión Específica:");
      parts.push(`S: ${metadata.validation.metrics.specific.sensitivity}%`);
      parts.push(`E: ${metadata.validation.metrics.specific.specificity}%`);
      if ("precision" in metadata.validation.metrics.specific) {
        parts.push(`P: ${metadata.validation.metrics.specific.precision}%`);
      }
    }
  }

  if (metadata.validation?.reference) {
    parts.push(`\nFuente: ${metadata.validation.reference}`);
  }

  return parts.join(" | ");
}
```

### Consideraciones para Tooltips:

- Usar el operador `?.` para acceso seguro a propiedades
- Verificar existencia de propiedades con `'propiedad' in objeto`
- Manejar correctamente casos sin métricas
- Mantener formato consistente en la salida

## Mantenimiento y Actualización

### Al Crear Nuevos Filtros:

1. Identificar el tipo de filtro (simple, doble o sin métricas)
2. Usar la plantilla correspondiente
3. Verificar formato JSON del metadata
4. Comprobar funcionamiento del tooltip

### Al Actualizar Filtros:

1. Mantener consistencia en el formato de fecha
2. Documentar modificaciones en la referencia
3. Actualizar métricas si es necesario
4. Verificar funcionamiento del tooltip

## Resolución de Problemas

### Errores Comunes:

1. JSON mal formateado en metadata
2. Acceso incorrecto a propiedades anidadas
3. Falta de manejo de casos opcionales
4. Referencias demasiado extensas en tooltips

### Verificación:

1. Validar JSON del metadata
2. Comprobar existencia de línea en blanco antes de metadata
3. Verificar formato de métricas según tipo de filtro
4. Probar visualización del tooltip

¿Quieres que prepare el prompt para futura referencia?
