const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, 'filters', 'journals', 'REVISTAS TOP EN GOOGLE SCHOLAR INDICE H5 - para web de buscar.csv');
const outputPath = path.join(__dirname, 'filters', 'journals', 'google_scholar_urls.json');

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
        else { current += char; }
    }
    result.push(current.trim());
    return result;
}

function generateUrls() {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const specialties = new Set();

    // Skip header
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = parseCSVLine(line);
        // Column 1 is Specialty Name
        if (cols[1]) {
            // Remove surrounding quotes if present
            const name = cols[1].replace(/^"|"$/g, '');
            specialties.add(name);
        }
    }

    const urls = [];
    specialties.forEach(name => {
        // Pattern: med_ + name lowercased, no symbols
        const suffix = name.toLowerCase().replace(/[^a-z]/g, ''); // Scholar seems to strip spaces and symbols?
        // Let's verify against known good ones:
        // "AIDS & HIV" -> "aidshiv"
        // "Audiology, Speech & Language Pathology" -> "audiologyspeechlanguagepathology"
        // Seems correct (remove non-alpha chars).

        const url = `https://scholar.google.com/citations?view_op=top_venues&hl=es&vq=med_${suffix}`;
        urls.push({ name, url });
    });

    fs.writeFileSync(outputPath, JSON.stringify(urls, null, 2));
    console.log(`Generated ${urls.length} URLs in ${outputPath}`);

    // Log first 5 for verification
    console.log('Sample URLs:');
    urls.slice(0, 5).forEach(u => console.log(`${u.name}: ${u.url}`));
}

generateUrls();
