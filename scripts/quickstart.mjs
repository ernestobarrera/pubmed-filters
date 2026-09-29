#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseFilter, compose, inspectResponse } from './parse-filter.mjs';

const filter = parseFilter(readFileSync('filters/clinical/treatment_especifico.txt', 'utf8'));
const term = compose('metformin[tiab]', filter);

// La consulta va en el cuerpo, por POST: con un tema real y un filtro largo, un GET devuelve
// HTTP 414 (query_execution_contract.transport_carries_the_whole_query).
const body = new URLSearchParams({
  db: 'pubmed',
  retmode: 'json',
  retmax: '0',
  tool: 'pubmed_filters_quickstart',
  term,
});

const payload = await fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
  method: 'POST',
  body,
}).then((response) => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
});
const inspection = inspectResponse(payload.esearchresult);
console.log(JSON.stringify({ term, transport: 'POST', count: payload.esearchresult?.count, inspection }, null, 2));
if (!inspection.usable) process.exitCode = 1;
