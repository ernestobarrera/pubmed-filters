#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseFilter, compose, inspectResponse } from './parse-filter.mjs';

const filter = parseFilter(readFileSync('filters/clinical/treatment_especifico.txt', 'utf8'));
const term = compose('metformin[tiab]', filter);
const url = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
url.search = new URLSearchParams({
  db: 'pubmed',
  retmode: 'json',
  retmax: '0',
  tool: 'pubmed_filters_quickstart',
  term,
}).toString();

const payload = await fetch(url).then((response) => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
});
const inspection = inspectResponse(payload.esearchresult);
console.log(JSON.stringify({ term, count: payload.esearchresult?.count, inspection }, null, 2));
if (!inspection.usable) process.exitCode = 1;
