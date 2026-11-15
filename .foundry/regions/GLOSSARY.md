# permissions glossary

**Every term permissions's region Wardens use, alphabetical, each with the region that holds it.**

<!-- Generated with the region Warden docs by the region pipeline's assemble.py. A term defined by two regions appears once per region. -->

---

## A

**ABAC**  
json-rules conditions ({ rule }) on the record and on the actor under __actor. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**absent: 'unknown'**  
How pass one reads a placed record: a missing field fails every positive leaf. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**action-rules**  
Class: the ActionRule algebra, RebacSchema actions and per-record permissionRules. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**ActionRule**  
string | { rel, action } | { rule } | { any } | { all } | boolean | null: what one action means. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**actor**  
Class: who is acting, set with permix.setActor({ model, record }) and read by rules as __actor. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**__actor**  
Reserved key holding { model, record } of who is acting; null when nobody is. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**Admission**  
One way a check is admitted: a list of Chains of entitlement refs, holder first. *Region:* [Running a permission check](running-a-check/knowledge.md)

**admission-paths**  
Class: createRebacPaths, admission chains of entitlement refs, limit and PathLimitError. *Region:* [Running a permission check](running-a-check/knowledge.md)

**anchor**  
The record an entitlement hangs from; only its id is fixed, path names the relations up to it. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**anchor.path**  
Dotted to-one relations from the record up to the anchor; none for a self anchor. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**any / all**  
OR and AND composition of ActionRules; all is how a rule narrows. *Region:* [Writing permission rules](permission-rules/knowledge.md)

## B

**bridge**  
A json-rules Bridge between two fieldMaps declared in schema.bridges; only to-one directions walk. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**bridges**  
Class: cross-source rel walks through schema bridges and far rows passed as subject.data. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**bun run bench**  
Times checks by walk depth and entitlements held; add *.bench.ts for your shapes. *Region:* [Running a permission check](running-a-check/knowledge.md)

## C

**capAtRole**  
capAtRole(schema, entry, ceiling): keeps an entry's actions the ceiling reaches by delegation. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**ceiling**  
The action a delegate's role maps to; role grants kept up to it, entitlements dropped. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**Chain**  
Entitlement refs along one delegated route; null for an entitlement without a ref. *Region:* [Running a permission check](running-a-check/knowledge.md)

**check-engine**  
Class: createRebacCheck and check(permix, schema, subject, action), walk order, cycles, idField. *Region:* [Running a permission check](running-a-check/knowledge.md)

**check-performance**  
Class: check cost by walk depth and entitlements held; bun run bench. *Region:* [Running a permission check](running-a-check/knowledge.md)

**comparison**  
Class tag: this library versus SpiceDB, OpenFGA, Permify, Cedar, Oso, Cerbos, Casbin, CASL, OPA. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**COMPARISON.md**  
The shipped comparison with other systems, including where others are ahead. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**createCanGrantEntitlement**  
createCanGrantEntitlement(map) returns canGrantEntitlement(writer, schema, entry, placed). *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**createHydrator**  
createHydrator({ map, load }) loads every FK-owning to-one relation recursively. *Region:* [Running a permission check](running-a-check/knowledge.md)

**createPermissions**  
Creates a permix; then permix.setup(entries, { owner?, replace? }). *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**createRebacCheck**  
createRebacCheck(map, { absent? }) returns the synchronous check(permix, schema, subject, actionOrRule). *Region:* [Running a permission check](running-a-check/knowledge.md)

**createRebacPaths**  
createRebacPaths(map, { absent?, limit = 20 }): the check's walk without stopping, every admission. *Region:* [Running a permission check](running-a-check/knowledge.md)

**cycle detection**  
By object identity plus table walked: a schema loop throws, a grant-data loop contributes nothing. *Region:* [Running a permission check](running-a-check/knowledge.md)

## D

**delegate**  
delegate(schema, owner, { full?, ceiling?, entitlements? }) resolves a delegate's Permissions. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**delegatedWhere**  
delegatedWhere(held, ...added): flat all of added conditions then held conjuncts; the only accepted narrowing. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**delegation**  
Class: tokens and integrations acting for an owner: delegate, capAtRole, Permissions, permixOf. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**Delegation that stays honest**  
Every entitlement is re-checked live against its grantor at every use, up the chain. *Region:* [Library scope and comparison](library-scope/knowledge.md)

## E

**EntitlementEntry**  
{ resource, anchor: { resource, id, path? }, where?, actions, ref? }. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**entitlementProblem**  
Names what is wrong with an entitlement entry, or null. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**entitlements**  
Class: access anchored on a record and backed by its owner's permissions. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**exact strings**  
Every rule runs with string.caseInsensitive and string.fuzzy off, whatever the app sets. *Region:* [Running a permission check](running-a-check/knowledge.md)

## F

**fromFields**  
The FK columns on the record a walked to-one relation owns. *Region:* [Running a permission check](running-a-check/knowledge.md)

**full**  
The owner's permissions whole, entitlements included; who may set it is app policy. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

## G

**getJSON**  
Serializes a permix's grants only, never its entitlements. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**grant**  
A table entry { resource, id?, actions } keyed resource or resource:id, from a role. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**granting**  
Class: whether a writer may grant an entitlement: createCanGrantEntitlement, placement, delegatedWhere. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

## H

**hydration**  
Class: createHydrator loading a record's to-one ownership closure through the app's load. *Region:* [Running a permission check](running-a-check/knowledge.md)

## I

**@inixiative/permissions**  
The published Bun/TypeScript package; one entry, depends only on @inixiative/json-rules and lodash-es. *Region:* [Library scope and comparison](library-scope/knowledge.md)

## L

**library-overview**  
Class tag: what the package is and its vocabulary; one check covering RBAC, ReBAC, ABAC and delegation. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**licensing**  
A tenant passing on actions on its own resources as entitlements owned by its table. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**load**  
The app's own loader that createHydrator calls; caching goes here. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**load**  
The app's load(resource, where) read by target columns; the cache seam across calls. *Region:* [Running a permission check](running-a-check/knowledge.md)

## M

**map:model**  
A map-qualified resource key (db:User, crm:Account) used in schemas and as bridge segments. *Region:* [Writing permission rules](permission-rules/knowledge.md)

## N

**No second store**  
A check reads the app's own hydrated records; no tuples to dual-write, no consistency tokens. *Region:* [Library scope and comparison](library-scope/knowledge.md)

## O

**{ ok, errors }**  
The json-rules result shape every validator returns. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**own-row rule**  
{ rel: 'user', action } on a row hydrated with its user; there is no self arm. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**owner**  
The grantor's permix passed to setup; re-walked live on the record at every use. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**ownership closure**  
Every to-one relation that owns its foreign key, recursively: what a check walks. *Region:* [Running a permission check](running-a-check/knowledge.md)

## P

**package-layout**  
Class tag: where code belongs; src/core never imports src/helpers, fetching and role mapping stay in the app. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**PathLimitError**  
Thrown when admissions exceed the limit; the limit bounds the result, not the walk. *Region:* [Running a permission check](running-a-check/knowledge.md)

**permissionRules**  
A record's JSON field action → ActionRule, ORed with the schema rule; only widens. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**Permissions**  
{ entries, owner? }[]: groups of role grants or owner-backed entitlements, as data. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**@permissions(hydrate: false)**  
Prisma-map annotation (/// comment) that makes the hydrator skip an edge. *Region:* [Running a permission check](running-a-check/knowledge.md)

**permissions.idField**  
json-rules engine setting naming the field grants are keyed by; default id. *Region:* [Running a permission check](running-a-check/knowledge.md)

**PermissionsEngineGlobals**  
Exported type that makes engineGlobals.set('permissions.idField', …) typecheck. *Region:* [Running a permission check](running-a-check/knowledge.md)

**permix**  
Class: the actor's holder, from createPermissions: grant table, entitlements, superadmin flag, actor. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**permix**  
The installed form of the actor's permissions that check reads (createPermissions). *Region:* [Library scope and comparison](library-scope/knowledge.md)

**PermixLike**  
The slice of a permix the engine reads. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**placeEntitlement**  
Builds the pseudo records a grant is judged on from the hydrated anchor; null if malformed. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**placeUnder**  
Lower-level placement of a resource's records under an anchor along a path, no entry validation. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**polymorphism registry**  
The false-polymorphism map: model → axes of { field, fkMap }. *Region:* [Running a permission check](running-a-check/knowledge.md)

**Positive by design**  
No deny rules; narrow by composing a stricter rule with all; validateActionRule refuses negation. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**positive rule**  
No negation, isEmpty, notExists, if/then/else, array or aggregate rule; validateRule(..., { positive: true }). *Region:* [Writing permission rules](permission-rules/knowledge.md)

**pseudo record**  
The would-be row a create or a grant is checked on. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**Pseudo record**  
A would-be row a create or grant is checked on before it exists. *Region:* [Writing permission rules](permission-rules/knowledge.md)

## R

**RBAC**  
Roles as table grants ({ resource, id?, actions }) held by the permix. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**reachableFrom**  
The actions on a resource whose holding grants a given action by pure delegation. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**ReBAC**  
Relationship walks ({ rel, action }) over the schema's to-one relations. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**RebacSchema**  
{ bridges?, permissions: { [resource]: { actions: { [name]: ActionRule } } } }. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**ref**  
The app's id for an entitlement row; shows in createRebacPaths chains. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**reflection**  
1.0 roadmap: the same rules compiled to a Prisma where and SQL; not built. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**{ rel, action }**  
Walk a dotted to-one relation path (space.organization) and check action on the target. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**reverse lookup**  
Who can read this record; a 1.0 roadmap question, not available today. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**roadmap**  
Class tag: not built yet; the 1.0 reflection of rules to a Prisma where and SQL, listing, reverse lookup. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**row rule**  
A record's own permissionRules entry, authored by a tenant, validated before save, can only widen. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**RuBAC**  
Rules as data: every condition is a serializable json-rules rule, positive by design. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**{ rule }**  
A positive json-rules Condition over the record, with the actor under __actor. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**rule-validation**  
Class: keeping rules positive and acyclic with validateActionRule, validateSchema and schemaRuleIssues. *Region:* [Writing permission rules](permission-rules/knowledge.md)

## S

**schema map**  
The SchemaMap passed to the check: resources to models, the fieldMap, the polymorphism registry. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**schema-map**  
Class: the SchemaMap every walk, placement and hydrator reads. *Region:* [Running a permission check](running-a-check/knowledge.md)

**SchemaMap**  
{ resources: resource → model, fieldMap (json-rules FieldMap / prisma-map), polymorphism? }. *Region:* [Running a permission check](running-a-check/knowledge.md)

**schemaRuleIssues**  
Lists every schema rule that is not well formed and positive, without the map or cycle check. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**src/core**  
The library: algebra, check, permix, entitlements, grant check, validation; never imports a helper. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**src/helpers**  
Optional delegation and hydration building blocks on top of the core. *Region:* [Library scope and comparison](library-scope/knowledge.md)

**string delegation**  
An ActionRule that is another action's name on the same resource (manage: 'own'). *Region:* [Writing permission rules](permission-rules/knowledge.md)

**Subject**  
{ resource, record, data? }: what a check is asked about; data holds bridge far rows. *Region:* [Running a permission check](running-a-check/knowledge.md)

**subject.data**  
Far rows backing bridge hops, keyed map:model; a missing far row denies. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**superadmin**  
Permix flag that short-circuits the walk, though a refused schema still throws. *Region:* [Running a permission check](running-a-check/knowledge.md)

## T

**tenant-boundaries**  
Class: membership (acting as the tenant) versus entitlements the tenant owns (licensing). *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**terminal null**  
Denies by rule; the top of a chain (own: null) is reached only by grants or row rules. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**test/layout.test.ts**  
The test that enforces src/core never imports src/helpers. *Region:* [Library scope and comparison](library-scope/knowledge.md)

## V

**validateActionRule**  
Checks one serialized ActionRule's shape and positivity; with { schema, resource, action } also refuses cycles. *Region:* [Writing permission rules](permission-rules/knowledge.md)

**validateSchema**  
Checks a whole schema against a SchemaMap: rules, rel segments, defined actions; for a test or boot. *Region:* [Writing permission rules](permission-rules/knowledge.md)

## W

**walk order**  
superadmin, permix table (id then resource-wide), schema rule OR row rule, then entitlements. *Region:* [Running a permission check](running-a-check/knowledge.md)

**wellFormedEntitlements**  
Keeps the stored entries setup would accept, without redundant ones. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

**where**  
Positive json-rules over the record; the holder written in as a literal; where: null is refused. *Region:* [Grants, entitlements and delegation](grants-and-entitlements/knowledge.md)

## Z

**Zanzibar family**  
SpiceDB, OpenFGA, Permify: tuple stores the app keeps in sync, unlike this library. *Region:* [Library scope and comparison](library-scope/knowledge.md)
