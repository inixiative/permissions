import type { Condition } from '@inixiative/json-rules';
import {
  type ActionRule,
  type Admission,
  createCanGrantEntitlement,
  createPermissions,
  createRebacCheck,
  createRebacPaths,
  type EntitlementEntry,
  type PermissionEntry,
  type Permix,
  type RebacSchema,
  type Row,
  type SchemaMap,
} from '../../index';

// A walk case in the form a differential fuzzer of two builds writes: resources, row objects and
// tables of grants and entitlements, each by index; one row may be several objects. Resource i is
// `db:ri` (model `Mi`, columns `id`, `flag` and a foreign key per relation). `outcomesOfWalkCase`
// builds it fresh and runs `check` (absent null and unknown), `paths` (limit 2) and the grant check.

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
  resources: { rels: Relation[]; lists: List[] }[];
  schema: Record<string, Record<string, ActionRule>>;
  objects: CaseObject[];
  tables: CaseTable[];
  query: { object: number; action: ActionRule };
  grant: { ent: Omit<CaseEntitlement, 'owner' | 'ref'>; placed: number };
};

const resourceName = (index: number) => `db:r${index}`;
const modelName = (index: number) => `M${index}`;
const column = { kind: 'scalar', type: 'String', isList: false } as const;

const mapOfCase = (walkCase: WalkCase): SchemaMap => ({
  resources: Object.fromEntries(walkCase.resources.map((_, i) => [resourceName(i), modelName(i)])),
  fieldMap: {
    models: Object.fromEntries(
      walkCase.resources.map((resource, i) => [
        modelName(i),
        {
          fields: {
            id: { ...column, isId: true },
            flag: column,
            ...Object.fromEntries(
              resource.rels.flatMap((relation) => [
                [`${relation.name}Id`, column],
                [
                  relation.name,
                  {
                    kind: 'object',
                    type: modelName(relation.target),
                    isList: false,
                    fromFields: [`${relation.name}Id`],
                    toFields: ['id'],
                    relationName: `rn_${relation.name}`,
                  },
                ],
              ]),
            ),
            ...Object.fromEntries(
              resource.lists.map((list) => [
                list.name,
                {
                  kind: 'object',
                  type: modelName(list.item),
                  isList: true,
                  fromFields: [],
                  toFields: [],
                  relationName: `rn_${list.inverse}`,
                  annotations: { permissions: { down: list.down } },
                },
              ]),
            ),
          },
        },
      ]),
    ),
  },
});

const schemaOfCase = (walkCase: WalkCase): RebacSchema => ({
  permissions: Object.fromEntries(
    Object.entries(walkCase.schema).map(([index, actions]) => [
      resourceName(Number(index)),
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
  const map = mapOfCase(walkCase);
  const schema = schemaOfCase(walkCase);
  const rows = rowsOfCase(walkCase);
  const tables: Permix[] = walkCase.tables.map(() => createPermissions());
  for (const [t, table] of walkCase.tables.entries()) {
    const permix = tables[t] as Permix;
    if (table.actor) permix.setActor({ model: table.actor, record: { id: `actor${t}` } });
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
  };
  const action = structuredClone(walkCase.query.action);
  const placed = rows[walkCase.grant.placed] ?? record;
  return {
    check: outcome(() => createRebacCheck(map)(holder, schema, subject, action)),
    checkUnknown: outcome(() =>
      createRebacCheck(map, { absent: 'unknown' })(holder, schema, subject, action),
    ),
    paths: outcome(() => createRebacPaths(map, { limit: 2 })(holder, schema, subject, action)),
    grant: outcome(() =>
      createCanGrantEntitlement(map)(
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
