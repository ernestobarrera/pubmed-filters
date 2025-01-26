# Documentación de Filtros PubMed

## Estructura del Archivo

Cada archivo de filtro debe seguir una estructura específica con dos partes principales:

### 1. Cabecera de Documentación

```plaintext
# Filtro: Nombre del filtro
# Autor: @ernestob
# Fecha: DD-MM-YYYY
# Descripción: Descripción clara y concisa
# Referencia completa: Referencia bibliográfica completa
# URL: URL de la referencia (si existe)
```

#### Normas para la Cabecera:

- Usar el formato de fecha español (DD-MM-YYYY)
- Incluir una descripción clara del propósito del filtro
- La referencia completa debe incluir cualquier modificación realizada
- La URL es opcional

### 2. Filtro y Metadata

```plaintext
[CONTENIDO DEL FILTRO]

@@@FILTER_METADATA@@@
{
  "validation": {
    "reference": "Autor et al, título abreviado. Año"
  }
}
```

#### Normas para el Metadata:

- Mantener una línea en blanco antes de `@@@FILTER_METADATA@@@`
- La referencia en el tooltip debe ser breve y legible
- Formato: "Autor et al, título abreviado. Año"

## Guía de Estilo

### Para la Descripción:

- Ser conciso pero informativo
- Mencionar el tipo de contenido que recupera
- Incluir términos clave o acrónimos relevantes

### Para las Referencias:

- **Completa** (en cabecera): Incluir todos los detalles bibliográficos
- **Abreviada** (en metadata): Mantener solo lo esencial para identificación

## Ejemplos

### Ejemplo Bien Estructurado:

```plaintext
# Filtro: Medicina Basada en la evidencia
# Autor: @ernestob
# Fecha: 03-09-2022
# Descripción: Búsqueda de artículos y recursos sobre MBE incluyendo journal clubs
# Referencia completa: Rohwer A, et al. E-learning of EBHC... (2017)
# URL: https://doi.org/...

[CONTENIDO DEL FILTRO]

@@@FILTER_METADATA@@@
{
  "validation": {
    "reference": "Rohwer A, et al. E-learning of EBHC. 2017"
  }
}
```

## Mantenimiento

### Al Crear Nuevos Filtros:

1. Usar la plantilla base
2. Verificar la sintaxis del filtro
3. Comprobar que el JSON del metadata es válido

### Al Actualizar Filtros:

1. Actualizar la fecha
2. Documentar modificaciones en la referencia completa
3. Mantener la brevedad en la referencia del tooltip

## Consejos Adicionales

- Mantener consistencia en el formato
- Verificar que el tooltip funciona correctamente
- Documentar cualquier modificación al filtro original
- Mantener las referencias actualizadas

## Resolución de Problemas

### Si el Tooltip No Funciona:

1. Verificar formato JSON del metadata
2. Comprobar que existe una línea en blanco antes de `@@@FILTER_METADATA@@@`
3. Verificar que la referencia está correctamente formateada

### Errores Comunes:

- Falta de línea en blanco antes del metadata
- JSON mal formateado
- Referencias demasiado largas en el tooltip
