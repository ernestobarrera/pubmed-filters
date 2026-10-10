#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseFilter, compose, inspectResponse } from './parse-filter.mjs';
import { esearch } from './esearch.mjs';

const filter = parseFilter(readFileSync('filters/clinical/treatment_especifico.txt', 'utf8'));
const term = compose('metformin[tiab]', filter);

const { transport, esearchresult } = await esearch(term, {
  params: { retmax: '0', tool: 'pubmed_filters_quickstart' },
});
const inspection = inspectResponse(esearchresult, { sentQuery: term });
console.log(JSON.stringify({ term, transport, count: esearchresult?.count, inspection }, null, 2));
if (!inspection.usable) process.exitCode = 1;
