import { listFields, type ValidationIssue, type ValidationResult } from '@inixiative/json-rules';
import { bridgeHop } from './bridgeHop';
import { fieldOf, listOf, resolveField, type SchemaMap } from './schemaMap';
import type { ActionRule, RebacSchema } from './types';
import { validateActionRule } from './validateActionRule';

// Inside a list arm's `condition`: the list's declared paths, and the relations walked from the
// item so far. Only what the declaration loads is on an item, so every walk must stay inside it.
type Under = {
  list: string;
  declared: readonly (readonly string[])[];
  prefix: readonly string[];
  seen: Set<string>;
};

const loaded = (under: Under, prefix: readonly string[]) =>
  under.declared.some((path) => prefix.every((segment, index) => path[index] === segment));

const notLoaded = (under: Under, prefix: readonly string[], path: string): ValidationIssue => ({
  path,
  code: 'down',
  message: `\`${under.list}\` loads no \`${prefix.join('.')}\` under an item: name it in \`/// @permissions(down: [...])\``,
});

const relationsRead = (map: SchemaMap, resource: string, field: string): string[] => {
  const read: string[] = [];
  let current: string | null = resource;
  for (const segment of field.split('.')) {
    if (!current || fieldOf(map, current, segment)?.kind !== 'object') break;
    read.push(segment);
    current = resolveField(map, current, segment);
  }
  return read;
};

const relIssues = (
  map: SchemaMap,
  schema: RebacSchema,
  resource: string,
  rule: ActionRule,
  path: string,
  under?: Under,
): ValidationIssue[] => {
  const follow = (landed: string, action: string, at: Under): ValidationIssue[] => {
    const key = `${landed}\u0000${action}\u0000${at.prefix.join('.')}`;
    if (at.seen.has(key)) return [];
    at.seen.add(key);
    return relIssues(
      map,
      schema,
      landed,
      schema.permissions[landed]?.actions[action] ?? null,
      path,
      at,
    );
  };
  if (rule === null || typeof rule !== 'object') {
    if (typeof rule !== 'string') return [];
    if (!(rule in (schema.permissions[resource]?.actions ?? {})))
      return [{ path, code: 'action', message: `\`${resource}\` has no action \`${rule}\`` }];
    return under ? follow(resource, rule, under) : [];
  }
  if ('any' in rule)
    return rule.any.flatMap((child, i) =>
      relIssues(map, schema, resource, child, `${path}.any[${i}]`, under),
    );
  if ('all' in rule)
    return rule.all.flatMap((child, i) =>
      relIssues(map, schema, resource, child, `${path}.all[${i}]`, under),
    );
  if ('rule' in rule) {
    if (!under) return [];
    return listFields(rule.rule).flatMap((field) => {
      const prefix = [...under.prefix, ...relationsRead(map, resource, field)];
      return prefix.length > under.prefix.length && !loaded(under, prefix)
        ? [notLoaded(under, prefix, path)]
        : [];
    });
  }
  if ('arrayOperator' in rule) {
    if (under)
      return [
        {
          path,
          code: 'down',
          message: `\`${resource}.${rule.rel}\` is a second list under an item of \`${under.list}\`: one list per walk`,
        },
      ];
    const list = listOf(map, resource, rule.rel);
    if (!list)
      return [
        {
          path,
          code: 'down',
          message: `\`${resource}.${rule.rel}\` is not a declared list: mark the list field \`/// @permissions(down: [...])\``,
        },
      ];
    return relIssues(map, schema, list.resource, rule.condition, `${path}.condition`, {
      list: `${resource}.${rule.rel}`,
      declared: list.paths,
      prefix: [],
      seen: new Set(),
    });
  }
  let current = resource;
  let prefix = under?.prefix ?? [];
  for (const segment of rule.rel.split('.')) {
    const hop = bridgeHop(schema.bridges, current, segment);
    if (hop && under)
      return [
        {
          path,
          code: 'down',
          message: `\`${segment}\` is a bridge under an item of \`${under.list}\`: a walk under an item stays on the declared relations`,
        },
      ];
    if (!hop && fieldOf(map, current, segment)?.isList)
      return [
        {
          path,
          code: 'relation',
          message: `\`${current}.${segment}\` is a list: cross it with { rel, arrayOperator: 'any', condition }`,
        },
      ];
    const next = hop ? hop.farResource : resolveField(map, current, segment);
    if (!next)
      return [{ path, code: 'relation', message: `\`${current}\` has no relation \`${segment}\`` }];
    prefix = [...prefix, segment];
    if (under && !loaded(under, prefix)) return [notLoaded(under, prefix, path)];
    current = next;
  }
  if (!(rule.action in (schema.permissions[current]?.actions ?? {})))
    return [{ path, code: 'action', message: `\`${current}\` has no action \`${rule.action}\`` }];
  return under ? follow(current, rule.action, { ...under, prefix }) : [];
};

/** Every action rule of a schema that is not well formed and positive, by `resource.action`. */
export const schemaRuleIssues = (schema: RebacSchema): ValidationIssue[] =>
  Object.entries(schema.permissions).flatMap(([resource, permission]) =>
    Object.entries(permission?.actions ?? {}).flatMap(([action, rule]) =>
      validateActionRule(rule).errors.map((issue) => ({
        ...issue,
        path: `${resource}.${action}${issue.path.slice(1)}`,
      })),
    ),
  );

/**
 * Every list arm of a schema that the map's declarations do not carry (code `down`), by
 * `resource.action`: an arm over an undeclared list, a relation walked or read under an item
 * outside the declared paths (followed through the actions the walk lands on), a second list or a
 * bridge under an item. A check refuses a schema that has one, on first use.
 */
export const declarationIssues = (map: SchemaMap, schema: RebacSchema): ValidationIssue[] =>
  Object.entries(schema.permissions).flatMap(([resource, permission]) =>
    Object.entries(permission?.actions ?? {}).flatMap(([action, rule]) =>
      validateActionRule(rule).ok
        ? relIssues(map, schema, resource, rule, `${resource}.${action}`).filter(
            (issue) => issue.code === 'down',
          )
        : [],
    ),
  );

/**
 * A whole schema checked against the map, for a test or boot: every action rule well formed and
 * positive (`validateActionRule`), every `{ rel }` segment a to-one relation
 * or a bridge, every list crossed by a list arm declared (`/// @permissions(down: [...])`), every
 * relation walked or read under an item inside what that declaration loads (followed through the
 * actions the item's rule lands on), and every action a rule names defined where it lands. A rule
 * that names a relation the map doesn't have otherwise denies forever without saying why.
 */
export const validateSchema = (map: SchemaMap, schema: RebacSchema): ValidationResult => {
  const errors: ValidationIssue[] = [];
  for (const [resource, permission] of Object.entries(schema.permissions)) {
    for (const [action, rule] of Object.entries(permission?.actions ?? {})) {
      const at = `${resource}.${action}`;
      const shape = validateActionRule(rule, { schema, resource, action });
      errors.push(
        ...shape.errors.map((issue) => ({ ...issue, path: `${at}${issue.path.slice(1)}` })),
      );
      errors.push(...relIssues(map, schema, resource, rule, at));
    }
  }
  return { ok: errors.length === 0, errors };
};
