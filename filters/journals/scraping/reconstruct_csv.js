const fs = require('fs');
const path = require('path');

const filtersDir = path.join(__dirname, 'filters', 'journals');
const outputFile = path.join(filtersDir, 'REVISTAS TOP EN GOOGLE SCHOLAR INDICE H5 - para web de buscar.csv');

function parseTxtFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Extract Metadata
    const metadataMatch = content.match(/@@@FILTER_METADATA@@@\s*({[\s\S]*?})/);
    if (!metadataMatch) return null;

    let metadata;
    try {
        metadata = JSON.parse(metadataMatch[1]);
    } catch (e) {
        console.error(`Error parsing JSON in ${filePath}:`, e);
        return null;
    }

    // Extract Query
    // Query is usually the first non-comment line that starts with (
    const queryMatch = content.match(/^\((.*)\)$/m);
    if (!queryMatch) {
        // Try finding the line that starts with ( and ends with )
        const lines = content.split('\n');
        for (const line of lines) {
            if (line.trim().startsWith('(') && line.trim().endsWith(')')) {
                return { metadata, queryStr: line.trim() };
            }
        }
        return null;
    }

    return { metadata, queryStr: queryMatch[0] };
}

function reconstruct() {
    const files = fs.readdirSync(filtersDir).filter(f => f.endsWith('.txt'));
    let csvContent = `"Specialty Marker","Specialty Name","Journal Full Name","Query Part"\n`;

    console.log(`Found ${files.length} filter files.`);

    for (const file of files) {
        const filePath = path.join(filtersDir, file);
        const data = parseTxtFile(filePath);

        if (!data) {
            console.warn(`Skipping ${file}: Could not parse.`);
            continue;
        }

        const { metadata, queryStr } = data;
        const specialty = metadata.specialty;

        if (!specialty) {
            console.warn(`Skipping ${file}: No specialty in metadata.`);
            continue;
        }

        const journals = metadata.journals;
        // Remove outer parens and split by |
        const queryParts = queryStr.slice(1, -1).split('|');

        if (journals.length !== queryParts.length) {
            console.warn(`Warning ${file}: Journal count ${journals.length} != Query parts ${queryParts.length}. Mapping might be off.`);
            // Proceed anyway, usually they match index-wise.
        }

        for (let i = 0; i < journals.length; i++) {
            const jName = journals[i];
            const qPart = queryParts[i] || ''; // Handle mismatch if any

            // CSV Escape
            const escapedName = jName.replace(/"/g, '""');
            // Specialty marker only on first line of block? No, the original script seemed to take it from every line or reused previous.
            // Let's just put it on every line for safety or follow the format.
            // "Specialty Marker" seemed to be a grouping thing. 
            // process_journals_csv.js: 
            // columns[0] is marker. columns[1] is name.
            // If marker is present, it updates currentSpecialty.
            // I'll put the specialty name in both 0 and 1 or just 1.
            // Let's put it in [1] (Specialty Name) and leave [0] empty unless it's a variation?
            // Actually, looking at the code:
            // if (columns[0]) currentSpecialty = columns[0]
            // else if (columns[1]) currentSpecialty = columns[1]
            // So column 1 is safe.

            csvContent += `,"${specialty}","${escapedName}","${qPart}"\n`;
        }
    }

    fs.writeFileSync(outputFile, csvContent, 'utf-8');
    console.log(`Reconstructed CSV at ${outputFile}`);
}

reconstruct();
