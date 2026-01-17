// Script para separar journals.txt en archivos individuales por especialidad
// Usa rangos de líneas fijos basados en el análisis del archivo
// Ejecutar con: node split_journals.js

const fs = require('fs');
const path = require('path');

// Rangos de líneas para cada especialidad (basado en análisis del archivo)
// Formato: [nombre, línea_inicio, línea_fin, emoji, nombre_display]
const specialtyRanges = [
    // Se omiten las líneas 1-20 (revistas generales top)
    ['addiction', 21, 40, '🧪', 'Addiction'],
    ['aids_hiv', 41, 60, '🔴', 'AIDS & HIV'],
    ['alternative_medicine', 61, 78, '🌿', 'Alternative & Traditional Medicine'],
    ['anesthesiology', 82, 100, '💉', 'Anesthesiology'],
    ['audiology_speech', 101, 120, '👂', 'Audiology, Speech & Language'],
    ['bioethics', 121, 140, '⚖️', 'Bioethics'],
    ['biomedical_tech', 141, 160, '🔬', 'Biomedical Technology'],
    ['cardiology', 161, 180, '❤️', 'Cardiology'],
    ['child_psychology', 181, 200, '👶', 'Child & Adolescent Psychology'],
    ['clinical_lab', 201, 220, '🧫', 'Clinical Laboratory Science'],
    ['communicable_diseases', 221, 240, '🦠', 'Communicable Diseases'],
    ['critical_care', 241, 260, '🏥', 'Critical Care'],
    ['dentistry', 261, 280, '🦷', 'Dentistry'],
    ['dermatology', 281, 300, '🩹', 'Dermatology'],
    ['developmental_disabilities', 301, 320, '🧩', 'Developmental Disabilities'],
    ['diabetes', 321, 340, '💊', 'Diabetes'],
    ['emergency_medicine', 341, 360, '🚑', 'Emergency Medicine'],
    ['endocrinology', 361, 380, '🧬', 'Endocrinology'],
    ['epidemiology', 381, 400, '📊', 'Epidemiology'],
    ['gastroenterology', 401, 420, '🫁', 'Gastroenterology & Hepatology'],
    ['genetics_genomics', 421, 440, '🧬', 'Genetics & Genomics'],
    ['geriatrics', 441, 460, '👴', 'Gerontology & Geriatric Medicine'],
    ['gynecology_obstetrics', 461, 480, '🤰', 'Gynecology & Obstetrics'],
    ['health_sciences_general', 481, 500, '🏛️', 'Health & Medical Sciences (General)'],
    ['heart_thoracic_surgery', 501, 520, '💓', 'Heart & Thoracic Surgery'],
    ['hematology', 521, 540, '🩸', 'Hematology'],
    ['hospice_palliative', 541, 560, '🕊️', 'Hospice & Palliative Care'],
    ['immunology', 561, 580, '🛡️', 'Immunology'],
    ['medical_informatics', 581, 600, '💻', 'Medical Informatics'],
    ['medicinal_chemistry', 601, 620, '⚗️', 'Medicinal Chemistry'],
    ['molecular_biology', 621, 640, '🔬', 'Molecular Biology'],
    ['natural_medicines', 641, 660, '🌱', 'Natural Medicines & Medicinal Plants'],
    ['neurology', 661, 680, '🧠', 'Neurology'],
    ['neurosurgery', 681, 700, '🧠', 'Neurosurgery'],
    ['nuclear_medicine', 701, 720, '☢️', 'Nuclear Medicine & Radiotherapy'],
    ['nursing', 721, 740, '👩‍⚕️', 'Nursing'],
    ['nutrition', 741, 760, '🥗', 'Nutrition Science'],
    ['obesity', 761, 780, '⚖️', 'Obesity'],
    ['oncology', 781, 800, '🎗️', 'Oncology'],
    ['ophthalmology', 801, 820, '👁️', 'Ophthalmology & Optometry'],
    ['oral_maxillofacial', 821, 840, '🦷', 'Oral & Maxillofacial Surgery'],
    ['orthopedics', 841, 860, '🦴', 'Orthopedic Medicine & Surgery'],
    ['otolaryngology', 861, 880, '👃', 'Otolaryngology'],
    ['pain_management', 881, 900, '💊', 'Pain & Pain Management'],
    ['pathology', 901, 920, '🔬', 'Pathology'],
    ['pediatrics', 921, 940, '👶', 'Pediatric Medicine'],
    ['pharmacology', 941, 960, '💊', 'Pharmacology & Pharmacy'],
    ['physical_education_sports', 961, 980, '🏃', 'Physical Education & Sports Medicine'],
    ['physiology', 981, 1000, '🫀', 'Physiology'],
    ['plastic_surgery', 1001, 1020, '✨', 'Plastic & Reconstructive Surgery'],
    ['pregnancy_childbirth', 1021, 1040, '🤱', 'Pregnancy & Childbirth'],
    ['primary_care', 1041, 1060, '🏠', 'Primary Health Care'],
    ['psychiatry', 1061, 1080, '🧠', 'Psychiatry'],
    ['psychology', 1081, 1100, '🧠', 'Psychology'],
    ['public_health', 1101, 1120, '🌍', 'Public Health'],
    ['pulmonology', 1121, 1140, '🫁', 'Pulmonology'],
    ['radiology', 1141, 1160, '📡', 'Radiology & Medical Imaging'],
    ['rehabilitation', 1161, 1180, '♿', 'Rehabilitation Therapy'],
    ['reproductive_health', 1181, 1200, '🔬', 'Reproductive Health'],
    ['rheumatology', 1201, 1220, '🦴', 'Rheumatology'],
    ['social_psychology', 1221, 1240, '👥', 'Social Psychology'],
    ['surgery', 1241, 1260, '🔪', 'Surgery'],
    ['toxicology', 1261, 1280, '☠️', 'Toxicology'],
    ['transplantation', 1281, 1300, '🫀', 'Transplantation'],
    ['tropical_medicine', 1301, 1320, '🌴', 'Tropical Medicine & Parasitology'],
    ['urology_nephrology', 1321, 1340, '🫘', 'Urology & Nephrology'],
    ['vascular_medicine', 1341, 1360, '🩸', 'Vascular Medicine'],
    ['veterinary', 1361, 1380, '🐾', 'Veterinary Medicine'],
    ['virology', 1381, 1400, '🦠', 'Virology']
];

const inputFile = path.join(__dirname, 'filters/journals/journals.txt');
const outputDir = path.join(__dirname, 'filters/journals');

// Leer archivo
const content = fs.readFileSync(inputFile, 'utf-8');
const lines = content.split(/\r?\n/);

console.log(`Total de líneas en archivo: ${lines.length}`);

// Procesar cada especialidad
for (const [name, startLine, endLine, emoji, displayName] of specialtyRanges) {
    // Extraer líneas (1-indexed a 0-indexed)
    const journalLines = lines.slice(startLine - 1, endLine);

    // Extraer solo la parte [JO] de cada línea
    const queries = journalLines
        .map(line => {
            const match = line.match(/"[^"]+"\[JO\]/);
            return match ? match[0] : null;
        })
        .filter(Boolean);

    if (queries.length === 0) {
        console.log(`⚠ ${name}: No se encontraron revistas en líneas ${startLine}-${endLine}`);
        continue;
    }

    const query = '(' + queries.join('|') + ')';

    const fileContent = `# Filtro: journals/${name}
# Descripción: Top ${queries.length} journals - ${emoji} ${displayName}
# Fuente: Google Scholar h5-index
# Fecha: 13-12-2024

${query}

@@@FILTER_METADATA@@@
{
  "validation": {
    "source": "Google Scholar h5-index",
    "year": 2024,
    "count": ${queries.length}
  }
}
`;

    const filePath = path.join(outputDir, `${name}.txt`);
    fs.writeFileSync(filePath, fileContent);
    console.log(`✓ ${name}.txt (${queries.length} revistas, líneas ${startLine}-${endLine})`);
}

// Generar archivo JSON con el mapeo para la web
const mappingFile = path.join(outputDir, 'specialty_mapping.json');
const mapping = specialtyRanges.map(([name, start, end, emoji, displayName]) => ({
    id: name,
    emoji: emoji,
    displayName: displayName,
    display: `${emoji} ${displayName}`
}));

fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2));
console.log(`\n✓ Creado: specialty_mapping.json`);
console.log('\nProceso completado!');
