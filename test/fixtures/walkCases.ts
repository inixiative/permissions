import type { Condition } from '@inixiative/json-rules';
import {
  type ActionRule,
  type Admission,
  createPermissions,
  type EntitlementEntry,
  type PermissionEntry,
  type Permix,
  type Row,
  type SchemaMap,
} from '../../index';
import {
  actorData,
  canGrantWithRules,
  checkWithRules,
  mapOf,
  pathsWithRules,
  type Rules,
} from '../schemaMaps';

// A walk case in the form a differential fuzzer of two builds writes: resources, row objects and
// tables of grants and entitlements, each by index; one row may be several objects. Each resource has
// columns `id`, `flag` and a foreign key per relation. `outcomesOfWalkCase`
// builds it fresh and runs `check` (absent null and unknown), `paths` (limit 2) and the grant check.
// `names` names the resources; without it resource i is `db:ri`.

type Relation = { name: string; target: number };
type List = { name: string; item: number; inverse: string; down: string[] };
type CaseObject = {
  res: number;
  id?: string;
  flag?: string;
  links: Record<string, number>;
  lists: Record<string, number[]>;
  permissionRules?: Record<string, ActionRule>;
};
type CaseEntitlement = {
  resource: number;
  path: string[];
  anchorId: string;
  where?: Condition;
  grantsBelow?: true;
  actions: string[];
  ref?: string;
  owner: number;
};
type CaseTable = {
  grants: { resource: number; id?: string; action: string }[];
  ents: CaseEntitlement[];
  actor: string | null;
  superadmin?: boolean;
};
export type WalkCase = {
  names?: string[];
  resources: { rels: Relation[]; lists: List[] }[];
  schema: Record<string, Record<string, ActionRule>>;
  objects: CaseObject[];
  tables: CaseTable[];
  query: { object: number; action: ActionRule };
  grant: { ent: Omit<CaseEntitlement, 'owner' | 'ref'>; placed: number };
};

/** A resource's name: the case's `names`, else `db:r<index>`. */
const resourceNameIn = (walkCase: WalkCase) => (index: number) =>
  walkCase.names?.[index] ?? `db:r${index}`;

const mapOfCase = (walkCase: WalkCase): SchemaMap => {
  const resourceName = resourceNameIn(walkCase);
  const names = walkCase.resources.map((_, i) => resourceName(i));
  const byResource = <V>(of: (resource: WalkCase['resources'][number]) => [string, V][]) =>
    Object.fromEntries(
      walkCase.resources.map((resource, i) => [names[i], Object.fromEntries(of(resource))]),
    );
  return mapOf(
    byResource((resource) =>
      resource.rels.map((relation) => [relation.name, resourceName(relation.target)]),
    ),
    Object.fromEntries(names.map((name) => [name, ['flag']])),
    byResource((resource) =>
      resource.lists.map((list) => [list.name, { item: resourceName(list.item), down: list.down }]),
    ),
  );
};

const schemaOfCase = (walkCase: WalkCase): Rules => ({
  permissions: Object.fromEntries(
    Object.entries(walkCase.schema).map(([index, actions]) => [
      resourceNameIn(walkCase)(Number(index)),
      { actions: structuredClone(actions) },
    ]),
  ),
});

const rowsOfCase = (walkCase: WalkCase): Row[] => {
  const rows: Row[] = walkCase.objects.map((object) => ({
    ...(object.id !== undefined ? { id: object.id } : {}),
    ...(object.flag !== undefined ? { flag: object.flag } : {}),
    ...(object.permissionRules ? { permissionRules: structuredClone(object.permissionRules) } : {}),
  }));
  walkCase.objects.forEach((object, i) => {
    const row = rows[i] as Row;
    for (const [relation, target] of Object.entries(object.links)) {
      const linked = rows[target];
      if (!linked) continue;
      row[relation] = linked;
      if (linked.id !== undefined) row[`${relation}Id`] = linked.id;
    }
    for (const [list, items] of Object.entries(object.lists))
      row[list] = items.flatMap((item) => (rows[item] ? [rows[item]] : []));
  });
  return rows;
};

const entryOfCase = (
  walkCase: WalkCase,
  entitlement: Omit<CaseEntitlement, 'owner'>,
): EntitlementEntry => {
  const resourceName = resourceNameIn(walkCase);
  let anchorResource = entitlement.resource;
  for (const segment of entitlement.path)
    anchorResource =
      walkCase.resources[anchorResource]?.rels.find((relation) => relation.name === segment)
        ?.target ?? anchorResource;
  return {
    resource: resourceName(entitlement.resource),
    anchor: {
      resource: resourceName(anchorResource),
      id: entitlement.anchorId,
      ...(entitlement.path.length ? { path: entitlement.path.join('.') } : {}),
    },
    ...(entitlement.where ? { where: structuredClone(entitlement.where) } : {}),
    ...(entitlement.grantsBelow ? { grantsBelow: true } : {}),
    actions: Object.fromEntries(entitlement.actions.map((action) => [action, true])),
    ...(entitlement.ref ? { ref: entitlement.ref } : {}),
  };
};

// A `paths` answer as sorted strings: one per admission, its chains joined by ` & `, each chain's refs by `>`.
const outcome = (run: () => boolean | Admission[]): boolean | string | string[] => {
  try {
    const value = run();
    return Array.isArray(value)
      ? value
          .map((admission) =>
            admission
              .map((chain) => chain.join('>'))
              .sort()
              .join(' & '),
          )
          .sort()
      : value;
  } catch (error) {
    return `throws ${(error as Error).name}: ${(error as Error).message}`;
  }
};

/** What `check` (absent null and unknown), `paths` (limit 2) and the grant check answer on a case. */
export const outcomesOfWalkCase = async (walkCase: WalkCase) => {
  const resourceName = resourceNameIn(walkCase);
  const map = mapOfCase(walkCase);
  const schema = schemaOfCase(walkCase);
  const rows = rowsOfCase(walkCase);
  const tables: Permix[] = walkCase.tables.map(() => createPermissions());
  for (const [t, table] of walkCase.tables.entries()) {
    const permix = tables[t] as Permix;
    if (table.superadmin) permix.setSuperadmin(true);
    if (table.grants.length)
      await permix.setup(
        table.grants.map(
          (grant) =>
            ({
              resource: resourceName(grant.resource),
              ...(grant.id ? { id: grant.id } : {}),
              actions: { [grant.action]: true },
            }) as PermissionEntry,
        ),
      );
    const byOwner = new Map<number, CaseEntitlement[]>();
    for (const entitlement of table.ents)
      byOwner.set(entitlement.owner, [...(byOwner.get(entitlement.owner) ?? []), entitlement]);
    for (const [owner, entitlements] of byOwner)
      await permix.setup(
        entitlements.map((entitlement) => entryOfCase(walkCase, entitlement)),
        { owner: tables[owner] ?? permix },
      );
  }
  const holder = tables[0] as Permix;
  const record = rows[walkCase.query.object] as Row;
  const subject = {
    resource: resourceName(walkCase.objects[walkCase.query.object]?.res ?? 0),
    record,
    data: actorData(walkCase.tables[0]?.actor ?? null, { id: 'actor0' }),
  };
  const action = structuredClone(walkCase.query.action);
  const placed = rows[walkCase.grant.placed] ?? record;
  return {
    check: outcome(() => checkWithRules(map)(holder, schema, subject, action)),
    paths: outcome(() => pathsWithRules(map, { limit: 2 })(holder, schema, subject, action)),
    grant: outcome(() =>
      canGrantWithRules(map)(
        holder,
        schema,
        entryOfCase(walkCase, { ...walkCase.grant.ent, ref: '' }),
        placed,
      ),
    ),
  };
};

export const walkCase = async (name: string): Promise<WalkCase> =>
  (await Bun.file(`${import.meta.dir}/walkCases/${name}.json`).json()) as WalkCase;
