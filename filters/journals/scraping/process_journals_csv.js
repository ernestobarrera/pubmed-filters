/**
 * Script para procesar el CSV de revistas y generar filtros PubMed
 * CON PREFIJO jnl_ para evitar conflictos con otros filtros
 */

const fs = require('fs');
const path = require('path');

// Paths
const csvPath = path.join(__dirname, 'filters', 'journals', 'REVISTAS TOP EN GOOGLE SCHOLAR INDICE H5 - para web de buscar.csv');
const outputDir = path.join(__dirname, 'filters', 'journals');
const jsDataPath = path.join(__dirname, 'journal_filters_data.js');

// Simple CSV line parser that handles quoted fields
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());

    return result;
}

// Clean up the query part - remove extra quotes
function cleanQueryPart(queryPart) {
    if (!queryPart) return null;
    // Remove leading/trailing quotes and clean up
    let cleaned = queryPart.replace(/^"+|"+$/g, '');
    // Ensure it ends with |
    if (cleaned && !cleaned.endsWith('|')) {
        cleaned += '|';
    }
    return cleaned || null;
}

// Convert specialty name to file-safe key WITH jnl_ prefix
function toFileKey(name) {
    const base = name
        .toLowerCase()
        .replace(/\s*&\s*/g, '_')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    return 'jnl_' + base;
}

// Main processing function
function processCSV() {
    console.log('Reading CSV file...');
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const lines = csvContent.split(/\r?\n/);

    // Group journals by specialty
    const specialties = {};
    let currentSpecialty = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const columns = parseCSVLine(line);

        const specialtyMarker = columns[0];
        const specialtyName = columns[1];
        const journalFull = columns[2];
        const queryPart = cleanQueryPart(columns[3]);

        // Update current specialty if we have a marker
        if (specialtyMarker && specialtyMarker.trim()) {
            currentSpecialty = specialtyMarker.trim();
        } else if (specialtyName && !specialties[specialtyName]) {
            currentSpecialty = specialtyName.trim();
        }

        // Skip if no specialty or no valid query
        if (!currentSpecialty || !queryPart) continue;

        // Initialize specialty if needed
        if (!specialties[currentSpecialty]) {
            specialties[currentSpecialty] = {
                name: currentSpecialty,
                key: toFileKey(currentSpecialty),
                journals: [],
                queryParts: []
            };
        }

        // Add journal if we have valid data
        if (journalFull && queryPart) {
            specialties[currentSpecialty].journals.push(journalFull);
            specialties[currentSpecialty].queryParts.push(queryPart);
        }
    }

    console.log(`Found ${Object.keys(specialties).length} specialties:`);

    // Generate output
    const allFilters = {};

    for (const [name, data] of Object.entries(specialties)) {
        // Skip empty specialties
        if (data.queryParts.length === 0) {
            console.log(`  - ${name}: SKIPPED (no journals)`);
            continue;
        }

        // Create the full query combining all journals with OR
        const queryString = '(' + data.queryParts.join('').slice(0, -1) + ')';

        console.log(`  - ${data.key}: ${data.journals.length} journals`);

        // Store for JS data file
        allFilters[data.key] = {
            name: name,
            description: `Top ${data.journals.length} journals in ${name} by Google Scholar h5-index`,
            journalCount: data.journals.length,
            query: queryString
        };

        // Generate individual filter file
        const filterContent = `# Filtro: journals/${data.key}
# Autor: Generado automáticamente desde Google Scholar h5-index
# Fecha: ${new Date().toISOString().split('T')[0]}
# Descripción: Top ${data.journals.length} revistas en ${name} según índice h5 de Google Scholar
# Fuente: Google Scholar Metrics - Top Publications

${queryString}

@@@FILTER_METADATA@@@
{
  "type": "journals",
  "specialty": "${name}",
  "journalCount": ${data.journals.length},
  "source": "Google Scholar h5-index",
  "journals": [
${data.journals.map(j => `    "${j.replace(/"/g, '\\"')}"`).join(',\n')}
  ]
}
`;

        // Write filter file WITH jnl_ prefix
        const filterPath = path.join(outputDir, `${data.key}.txt`);
        fs.writeFileSync(filterPath, filterContent, 'utf-8');
    }

    // Generate JavaScript data file
    const jsContent = `/**
 * Journal Filters Data
 * Generated from Google Scholar h5-index
 * Generated: ${new Date().toISOString()}
 * 
 * All IDs use jnl_ prefix to avoid conflicts with scope filters
 */

const JOURNAL_FILTERS = ${JSON.stringify(allFilters, null, 2)};

// Export for use in browser
if (typeof window !== 'undefined') {
  window.JOURNAL_FILTERS = JOURNAL_FILTERS;
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = JOURNAL_FILTERS;
}
`;

    fs.writeFileSync(jsDataPath, jsContent, 'utf-8');

    // Print list of all keys for updating categories/HTML
    console.log(`\n=== Filter IDs for categories object ===`);
    console.log(Object.keys(allFilters).map(k => `"${k}"`).join(',\n'));

    console.log(`\nGenerated:`);
    console.log(`  - ${Object.keys(allFilters).length} individual filter files in ${outputDir}`);
    console.log(`  - JavaScript data file: ${jsDataPath}`);

    return allFilters;
}

// Run
try {
    processCSV();
} catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
}
