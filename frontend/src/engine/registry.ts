import type {
  AttributeSpec,
  Issue,
  Ontology,
  OntologySpec,
  ResolvedRelation,
  ResolvedType,
  TypeSpec,
} from './types';

/**
 * Builds an ontology from the declarations an ontology module holds, merging
 * inheritance and reporting everything that stops those declarations being one.
 *
 * A type inherits its ancestors' attributes. The type that declares an
 * attribute decides, with `override: true`, whether a subtype may redeclare it;
 * a redeclaration may narrow the allowed values but never widen them, and may
 * not drop a requirement.
 *
 * A relation names the types allowed at either end. A subtype is accepted
 * wherever the relation names a type it extends (see `accepts`), so an ontology
 * writes `unit` once instead of listing every kind of unit.
 *
 * The result stays usable when `issues` is not empty: an offending declaration
 * is dropped rather than thrown, so an editor can keep rendering the rest of the
 * model while the author fixes the ontology.
 */
export function buildOntology(spec: OntologySpec): { ontology: Ontology; issues: Issue[] } {
  const issues: Issue[] = [];
  const declared = new Map<string, TypeSpec>();

  for (const type of spec.types) {
    if (declared.has(type.name)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-type',
        subject: type.name,
        message: `Type "${type.name}" is declared twice; the second declaration is ignored.`,
      });
      continue;
    }
    declared.set(type.name, type);
  }

  // The chain of ancestors of a type, ending with the type itself. A parent chain
  // that comes back on itself is reported once, at the type where the walk
  // noticed, and cut there; the ontology stays usable.
  const lineage = new Map<string, string[]>();
  const broken = new Set<string>();

  const walk = (name: string, path: readonly string[]): string[] => {
    const cached = lineage.get(name);
    if (cached) return cached;
    if (path.includes(name)) {
      if (!broken.has(name)) {
        broken.add(name);
        issues.push({
          severity: 'error',
          code: 'inheritance-cycle',
          subject: name,
          message: `Type "${name}" extends itself: ${[...path, name].join(' → ')}.`,
        });
      }
      return [name];
    }
    const chain: string[] = [];
    for (const parent of declared.get(name)?.extends ?? []) {
      if (!declared.has(parent)) {
        issues.push({
          severity: 'error',
          code: 'unknown-type',
          subject: name,
          message: `Type "${name}" extends "${parent}", which no type declares.`,
        });
        continue;
      }
      for (const ancestor of walk(parent, [...path, name])) {
        if (!chain.includes(ancestor)) chain.push(ancestor);
      }
    }
    if (!chain.includes(name)) chain.push(name);
    if (!broken.has(name)) lineage.set(name, chain);
    return chain;
  };

  for (const name of declared.keys()) walk(name, []);

  // A type whose chain was cut still gets an entry, so nothing downstream has to
  // special-case a missing type.
  for (const name of declared.keys()) {
    if (!lineage.has(name)) lineage.set(name, [name]);
  }

  const types: Record<string, ResolvedType> = {};
  for (const [name, chain] of lineage) {
    const attributes: Record<string, AttributeSpec> = {};
    const declaredBy: Record<string, string> = {};
    for (const ancestor of chain) {
      for (const [key, own] of Object.entries(declared.get(ancestor)?.attributes ?? {})) {
        const inherited = attributes[key];
        const from = declaredBy[key];
        if (inherited && from) {
          const problem = overrideProblem(inherited, own, from, name, key);
          if (problem) {
            issues.push(problem);
            // The inherited declaration stands, so the type keeps a shape a view can draw.
            continue;
          }
          attributes[key] = {
            ...own,
            required: (inherited.required ?? false) || (own.required ?? false),
          };
          declaredBy[key] = ancestor;
          continue;
        }
        attributes[key] = own;
        declaredBy[key] = ancestor;
      }
    }
    const type = declared.get(name);
    types[name] = {
      name,
      lineage: [...chain],
      attributes,
      instantiable: type?.instantiable ?? true,
      doc: type?.doc,
    };
  }

  const relations: Record<string, ResolvedRelation> = {};
  for (const relation of spec.relations) {
    if (relations[relation.name]) {
      issues.push({
        severity: 'error',
        code: 'duplicate-relation',
        subject: relation.name,
        message: `Relation "${relation.name}" is declared twice; the second declaration is ignored.`,
      });
      continue;
    }
    for (const end of ['source', 'target'] as const) {
      for (const type of relation[end] ?? []) {
        if (declared.has(type)) continue;
        issues.push({
          severity: 'error',
          code: 'unknown-type',
          subject: relation.name,
          message: `Relation "${relation.name}" allows "${type}" at its ${end}, which no type declares.`,
        });
      }
    }
    for (const [limit, value] of [
      ['maxOut', relation.maxOut],
      ['maxIn', relation.maxIn],
    ] as const) {
      if (value === undefined || (Number.isInteger(value) && value >= 1)) continue;
      issues.push({
        severity: 'error',
        code: 'bad-limit',
        subject: relation.name,
        message: `Relation "${relation.name}" has ${limit} ${value}; a limit is a whole number of one or more.`,
      });
    }
    relations[relation.name] = {
      name: relation.name,
      source: relation.source,
      target: relation.target,
      maxOut: relation.maxOut,
      maxIn: relation.maxIn,
      acyclic: relation.acyclic ?? false,
      allowSelfLoops: relation.allowSelfLoops ?? true,
      doc: relation.doc,
    };
  }

  // Every type once, each one after the types it extends.
  const order: string[] = [];
  const placed = new Set<string>();
  const place = (name: string): void => {
    if (placed.has(name)) return;
    placed.add(name);
    for (const parent of declared.get(name)?.extends ?? []) {
      if (declared.has(parent)) place(parent);
    }
    order.push(name);
  };
  for (const name of declared.keys()) place(name);

  const roots = order.filter((name) => (declared.get(name)?.extends ?? []).length === 0);

  return { ontology: { types, relations, order, roots }, issues };
}

/**
 * A redeclaration of an inherited attribute: allowed only when the type that
 * declares it opened it for override, the kind matches, and the allowed values do
 * not widen.
 */
function overrideProblem(
  inherited: AttributeSpec,
  own: AttributeSpec,
  from: string,
  name: string,
  key: string,
): Issue | undefined {
  const subject = `${name}.${key}`;
  if (inherited.override !== true) {
    return {
      severity: 'error',
      code: 'closed-override',
      subject,
      message: `"${key}" is declared by "${from}", which does not open it for override, so "${name}" may not redeclare it.`,
    };
  }
  if (own.kind !== inherited.kind) {
    return {
      severity: 'error',
      code: 'override-kind',
      subject,
      message: `"${name}.${key}" is a ${own.kind}, but "${from}" declares it as a ${inherited.kind}.`,
    };
  }
  const allowed = inherited.values;
  if (allowed && own.values) {
    const wider = own.values.filter((value) => !allowed.includes(value));
    if (wider.length > 0) {
      return {
        severity: 'error',
        code: 'wider-values',
        subject,
        message: `"${name}.${key}" allows ${describeValues(wider)}, which "${from}" does not; a redeclaration may narrow the allowed values, never widen them.`,
      };
    }
  }
  return undefined;
}

/** `"a", "b"` */
function describeValues(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join(', ');
}

/** The ancestors of a type, from the root of the chain down to the type itself; empty when undeclared. */
export function lineageOf(ontology: Ontology, type: string): readonly string[] {
  return ontology.types[type]?.lineage ?? [];
}

/** True when `type` is `ancestor`, or extends it through any number of steps. */
export function isA(ontology: Ontology, type: string, ancestor: string): boolean {
  return lineageOf(ontology, type).includes(ancestor);
}

/**
 * True when the relation allows a node of `type` at `end`; a relation that names
 * no types there allows every type.
 */
export function accepts(
  ontology: Ontology,
  relation: string,
  end: 'source' | 'target',
  type: string,
): boolean {
  const resolved = ontology.relations[relation];
  if (!resolved) return false;
  const allowed = end === 'source' ? resolved.source : resolved.target;
  if (!allowed) return true;
  return allowed.some((name) => isA(ontology, type, name));
}
