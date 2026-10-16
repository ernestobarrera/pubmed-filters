/**
 * ¿Respetan las estrategias 1.11 de la batería el papel que cada caso declara para sus facetas?
 *
 * Sin red: lo usan la suite (K6, en cada commit y en la CI) y la batería antes de gastar consultas.
 * Revisión de Codex del 2026-10-16: retirar la restricción geográfica del control positivo P conservaba
 * 11/11 y nada lo detectaba; la retención no basta para ver que una estrategia dejó de hacer lo que su
 * caso declara.
 *
 * Reglas, sobre la estrategia `contract_1_11` de cada caso:
 *  - una faceta `core` con filtros va con AND en TODAS las pasadas de la unidad (al menos uno de ellos);
 *  - una faceta `concept` con filtros entra en el bloque OR de algún concepto (or_concept);
 *  - una faceta `context` no aparece en ninguna pasada: quién pregunta no es restricción;
 *  - una faceta `lane` cuyo filtro es de ámbito o editorial no va con AND en la unidad de la afirmación.
 * Comprueba coherencia entre lo declarado y lo compuesto. No prueba que la declaración sea correcta.
 */

export function roleConformance(spec, roleOf) {
  const problems = [];
  for (const kase of spec.cases) {
    const plan = kase.strategies?.contract_1_11;
    if (!Array.isArray(plan) || plan.length === 0) { problems.push(`${kase.id}: sin estrategia contract_1_11`); continue; }
    const unit = plan.filter((p) => p.unit);
    if (unit.length === 0) problems.push(`${kase.id}: la estrategia 1.11 no declara unidad`);
    const anded = (p) => new Set(p.and ?? []);
    const inConcept = new Set(plan.flatMap((p) => p.or_concept?.filters ?? []));
    const everywhere = new Set(plan.flatMap((p) => [...(p.and ?? []), ...(p.or_concept?.filters ?? [])]));
    for (const f of kase.facets ?? []) {
      const fs = f.filters ?? [];
      if (fs.length === 0) continue;
      if (f.expected_role === 'core' && !unit.every((p) => fs.some((x) => anded(p).has(x)))) {
        problems.push(`${kase.id}: la faceta núcleo «${f.facet}» no va con AND en todas las pasadas de la unidad`);
      }
      if (f.expected_role === 'concept' && !fs.some((x) => inConcept.has(x))) {
        problems.push(`${kase.id}: la faceta concepto «${f.facet}» no entra con OR en su bloque`);
      }
      if (f.expected_role === 'context' && fs.some((x) => everywhere.has(x))) {
        problems.push(`${kase.id}: la faceta de contexto «${f.facet}» se usa como restricción`);
      }
      if (f.expected_role === 'lane') {
        const malos = fs.filter((x) => ['population_setting', 'editorial'].includes(roleOf[x]) && unit.some((p) => anded(p).has(x)));
        if (malos.length) problems.push(`${kase.id}: la faceta de pasada «${f.facet}» restringe la unidad con ${malos.join(', ')}`);
      }
    }
  }
  return problems;
}
