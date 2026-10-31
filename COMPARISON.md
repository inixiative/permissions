# How it compares

`@inixiative/permissions` is a small, MIT-licensed TypeScript library. It decides on your own records, in your own process, from rules that are plain JSON. Everything below is about what that changes compared with the systems teams usually reach for. Each cell cites the system's own docs (checked 2026-10-31).

## In short

- **No second store.** The Zanzibar family (SpiceDB, OpenFGA, Permify) and Oso Cloud keep their own copy of your relationships, and you keep it in sync. Here a check reads the records you already have. Nothing to dual-write, no consistency tokens, nothing to reconcile.
- **Rules are data, down to one record.** Every system lets an operator change the policy at runtime. Here a tenant can also write a rule on one of its own records, validated before it is saved, and the rule can only widen access. Policy can grow per tenant instead of being one global document.
- **Delegation that stays honest.** An entitlement names who granted it, and every check asks again whether that grantor still allows the action on that record, up the whole chain and across tenant boundaries. Demote anyone in the chain and everything they handed on stops on the next request, with nothing to clean up. None of the systems here documents this.
- **Granting is checked by the same rules.** Whether you may hand an entitlement on is decided by the same check, on a stand-in for every record the grant would reach. You can only grant what you could do on all of it.
- **Positive by design.** There are no deny rules. You narrow by composing a stricter rule, so there is no deny-versus-allow conflict to resolve, and a rule can never pass because a relation wasn't loaded.
- **Tiny.** The core is about a thousand lines; delegation and hydration helpers are about two hundred more. You can read all of it.

## The table

Columns: this library, SpiceDB, OpenFGA, Permify, Cedar and AWS Verified Permissions, Oso Cloud, Cerbos, Casbin, CASL, OPA.

| Capability | @inixiative/permissions | SpiceDB | OpenFGA | Permify | Cedar / AVP | Oso Cloud | Cerbos | Casbin | CASL | OPA |
|---|---|---|---|---|---|---|---|---|---|---|
| Runs in your process, no service | Yes | No, centralized service [S1] | No, server [O1] | No, centralized service [P1] | Cedar yes [C1]; AVP hosted API [C9] | No; service in every model [X1] | Service or sidecar [R1]; in-process ePDP is Hub, commercial [R2] | Yes; server optional [B1] | Yes [L1] | Sidecar, Go library or Wasm [A1][A2] |
| Decides on your own rows, no second store | Yes (hydrated record, `load` you own) | No; tuples, 2PC dual write [S2] | No; tuples via Write API [O2] | No; CDC pipeline recommended [P2] | Entities passed per request [C2] | Facts store; dual writes plus reconciliation, or Local Authorization with bindings [X2][X3] | Attributes passed per request [R1] | Policy rows via adapters [B2] | Rules built from your data per request [L2] | Data pushed, eventually consistent [A3] |
| Rules are JSON | Yes | DSL [S3] | JSON model, DSL compiles to it [O3] | DSL [P3] | DSL, JSON format exists [C3] | Polar text [X4] | YAML [R3] | conf plus rows [B4] | Yes, raw rules [L4] | Rego text; data JSON [A5] |
| Model or policy changed at runtime | Yes | WriteSchema [S3] | New immutable model version [O4] | WriteSchema [P3] | AVP policy API [C10] | Policy API [X4] | Reload drivers, Admin API [R3] | Adapters, watchers [B3] | Yes [L2] | Policy API, bundles [A4] |
| A tenant writes a rule on one record, validated, can only widen | Yes | Caveat params per tuple; logic in schema [S4] | Condition params per tuple; logic in model [O5] | Attribute values per record; logic in schema [P5] | Template-linked policy per record; any Cedar logic incl. forbid [C5][C10] | Fact per record; logic in global policy [X6] | No; pass state as attributes [R8] | Not documented [B5] | Conditions per ability, not stored per record [L1] | Not a named feature [A7] |
| Nested boolean of relation, attribute and actor conditions | Yes, recursive `any`/`all` | Yes, with caveats [S3][S4] | Yes [O3][O5] | Yes [P5] | Yes, `in` hierarchy, no recursion [C4][C15] | Yes [X15] | Yes, CEL; no relations [R5][R6] | One matcher expression [B4] | No `$and`/`$or` in a condition; no joins [L5][L6] | Yes [A5] |
| A relation condition asks the related record's own rule | Yes (`{ rel, action }`) | Arrows on objects; not on a subject's permission [S3] | Tuple-to-userset [O11] | Yes, relations [P6] | `in` on a passed hierarchy [C2] | Yes, via facts and rules [X6] | No relations [R1] | No | No | Written by hand [A5] |
| Entitlement re-checked against its grantor at every use | Yes | No; usersets resolve membership, not the grantor [S3] | No [O11] | No [P6] | No [C4] | No; impersonation and custom roles are static facts [X8][X7] | No [R8] | No; static inheritance [B7] | No [L1] | Not a feature [A5] |
| Grant-time check derived from the read-time rules | Yes | No; API credential [S2] | No [O2] | No [P5] | No; IAM [C10] | No [X10] | n/a, stateless | No | No | No |
| Delegate capped by the schema's action chain | Yes (`capAtRole`) | Not a feature | Not a feature | Not a feature | Not a feature | Not a feature | Not a feature | Not a feature | Not a feature | Not a feature |
| Negation | No, by design: you restrict by adding a condition (`all`), not by a deny that has to win a conflict | Exclusion [S3] | `but not` [O3] | `not` [P6] | `forbid`, `unless` [C4] | `not` on one fact [X5] | DENY, `!` [R7] | deny-override [B6] | `cannot` [L4] | `not` [A5] |
| Reverse lookup today | 1.0, end of 2026, as one query | Id lists; about 10k cap guidance [S5] | Id lists; 1,000 default, 3 s [O7][O8] | Id lists, paged 100 [P7] | Batch of 30 pre-enumerated pairs [C11]; Cedar partial eval experimental [C7] | Ids (`list`) or SQL WHERE (`list_local`) [X9] | Query plan AST, ORM adapters [R9][R10] | Implicit permission rows [B8] | Prisma `where` via `accessibleBy` [L7] | Compile API, partial eval [A4] |
| Compiles rules to a DB query | 1.0, end of 2026: Prisma and SQL | No | No | No | Experimental [C7] | Yes, `list_local` [X9] | Yes, adapters [R10] | No | Yes [L7] | Partial eval [A4] |
| Renaming a relation or action | A rename of stored strings; stranded entries grant nothing | Backfill tuples before removing [S6] | Copy tuples to the new name [O9] | Manual backfill, staged rollout [P1] | Re-validate policies by hand [C6] | Bridge rules, fact rewrite [X10] | Stateless; policy files only [R14] | Load-only models [B9] | Not documented | Schemaless data [A7] |
| Consistency tokens needed | No (one database) | ZedTokens [S7] | consistency param [O10] | Snap Tokens [P8] | AVP eventually consistent [C14] | Not documented | n/a | n/a | n/a | Eventually consistent data [A3] |
| Decision or audit log built in | No | Managed product only [S8] | Not documented [O12] | Not documented | AVP CloudTrail data events, off by default [C12] | Logs and Explain [X11] | Yes [R11] | Logger, off by default | No [L1] | Yes [A8] |
| Languages | TypeScript | Go, Node, Python, Java SDKs [S1] | JS, Go, .NET, Python, Java [O12] | Go, Node, Java, Python, PHP, Ruby, .NET [P9] | Rust, Go, Wasm (JS) [C8] | Node, Python, Go, Java, Ruby, .NET [X11] | 8 SDKs [R11] | Many ports [B12] | JS only [L7] | Go, Wasm [A2] |
| Playground, policy tests, analysis | No playground; tests are bun tests in your repo | Playground; no analyzer documented | Playground | Playground | Validator with proved soundness; SymCC verification [C8] | Polar tests [X13] | `cerbos compile` tests; play.cerbos.dev [R12] | Online editor [B11] | None [L8] | `opa test`, Rego Playground [A10] |
| License | MIT | Apache-2.0 [S1] | Apache-2.0 [O12] | AGPL-3.0, was Apache-2.0; acquired by FusionAuth [P9] | Apache-2.0; AVP paid [C8] | Commercial; OSS library archived 2026-10-22 [X14] | PDP Apache-2.0; Hub commercial [R13] | Apache-2.0 | MIT [L7] | Apache-2.0 [A8] |

## Where others are ahead

- **Listing today.** Oso Cloud (`list_local`), Cerbos (`PlanResources`) and CASL (`accessibleBy`) already turn "which records can I read" into a query; the Zanzibar family returns id lists. Here that arrives in 1.0, as a Prisma `where` and SQL, by the end of 2026.
- **Languages.** This is TypeScript. The others ship SDKs for several languages or a wire protocol.
- **Tooling.** Cerbos, OPA and Oso Cloud log decisions and explain them; Cedar ships a verifier; most have a playground. Here a check returns a boolean, and tests are your own.
- **Scale proof.** SpiceDB and OpenFGA publish benchmarks at very large tuple counts. Here a check is an in-process call on a loaded record, so it scales with your database and your loading.

## Sources

Checked 2026-10-31. Official docs unless marked.

SpiceDB
- [S1] https://authzed.com/docs/spicedb/getting-started/discovering-spicedb
- [S2] https://authzed.com/docs/spicedb/concepts/relationships
- [S3] https://authzed.com/docs/spicedb/concepts/schema
- [S4] https://authzed.com/docs/spicedb/concepts/caveats
- [S5] https://authzed.com/docs/spicedb/concepts/querying-data
- [S6] https://authzed.com/docs/spicedb/modeling/migrating-schema
- [S7] https://authzed.com/docs/spicedb/concepts/consistency
- [S8] https://authzed.com/docs/authzed/concepts/audit-logging
- [S9] https://authzed.com/blog/google-scale-authorization (blog, not docs)

OpenFGA
- [O1] https://openfga.dev/docs/getting-started/setup-openfga/overview
- [O2] https://openfga.dev/docs/interacting/transactional-writes
- [O3] https://openfga.dev/docs/configuration-language
- [O4] https://openfga.dev/docs/getting-started/immutable-models
- [O5] https://openfga.dev/docs/modeling/conditions
- [O6] https://openfga.dev/docs/modeling/token-claims-contextual-tuples
- [O7] https://openfga.dev/docs/interacting/relationship-queries
- [O8] https://openfga.dev/docs/best-practices/running-in-production
- [O9] https://openfga.dev/docs/modeling/migrating/migrating-relations
- [O10] https://openfga.dev/docs/interacting/consistency
- [O11] https://openfga.dev/docs/modeling/building-blocks/usersets
- [O12] https://openfga.dev/project and https://openfga.dev/docs/adopters/read-ai

Permify (docs now at fusionauth.io after the FusionAuth acquisition)
- [P1] https://fusionauth.io/permify-docs/permify-overview/faqs
- [P2] https://fusionauth.io/permify-docs/integrations/data-sync
- [P3] https://fusionauth.io/permify-docs/api-reference/schema/write-schema
- [P4] https://fusionauth.io/permify-docs/use-cases/multi-tenancy
- [P5] https://fusionauth.io/permify-docs/use-cases/abac
- [P6] https://fusionauth.io/permify-docs/getting-started/modeling
- [P7] https://fusionauth.io/permify-docs/api-reference/permission/lookup-entity
- [P8] https://fusionauth.io/permify-docs/operations/snap-tokens
- [P9] https://raw.githubusercontent.com/Permify/permify/master/README.md and https://raw.githubusercontent.com/Permify/permify/master/LICENSE (GitHub)

Cedar and AWS Verified Permissions
- [C1] https://docs.cedarpolicy.com/
- [C2] https://docs.cedarpolicy.com/auth/authorization.html
- [C3] https://docs.cedarpolicy.com/policies/json-format.html
- [C4] https://docs.cedarpolicy.com/policies/syntax-policy.html
- [C5] https://docs.cedarpolicy.com/policies/templates.html
- [C6] https://docs.cedarpolicy.com/policies/validation.html
- [C7] https://github.com/cedar-policy/cedar/blob/main/cedar-policy/CHANGELOG.md (GitHub)
- [C8] https://github.com/cedar-policy/cedar and https://github.com/cedar-policy/cedar/tree/main/cedar-policy-symcc (GitHub)
- [C9] https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/what-is-avp.html
- [C10] https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_CreatePolicy.html
- [C11] https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_BatchIsAuthorized.html
- [C12] https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/cloudtrail.html
- [C13] https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/quotas.html
- [C14] https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/identity-sources.html
- [C15] https://docs.cedarpolicy.com/policies/level-validation.html

Oso
- [X1] https://www.osohq.com/docs/deploy/deployment-models
- [X2] https://www.osohq.com/docs/develop/facts/sync-facts
- [X3] https://www.osohq.com/docs/develop/facts/local-authorization
- [X4] https://www.osohq.com/docs/reference/api/policy/post-policy
- [X5] https://www.osohq.com/docs/reference/polar/operators
- [X6] https://www.osohq.com/docs/develop/facts/overview
- [X7] https://www.osohq.com/docs/develop/policies/patterns/custom-roles
- [X8] https://www.osohq.com/docs/develop/policies/patterns/impersonation
- [X9] https://www.osohq.com/docs/develop/enforce/list-filtering
- [X10] https://www.osohq.com/docs/develop/facts/update-facts
- [X11] https://www.osohq.com/docs/develop/troubleshooting/explain and https://www.osohq.com/docs/reference/sdks/overview
- [X12] https://www.osohq.com/docs/oso-cloud-overview/oso-cloud-architecture
- [X13] https://www.osohq.com/docs/reference/polar/tests
- [X14] https://github.com/osohq/oso (GitHub; archived 2026-10-22)
- [X15] https://www.osohq.com/docs/reference/polar/resource-blocks

Cerbos
- [R1] https://docs.cerbos.dev/cerbos/latest/deployment/
- [R2] https://docs.cerbos.dev/cerbos-hub/deployments-epdp-rules.html
- [R3] https://docs.cerbos.dev/cerbos/latest/configuration/storage
- [R4] https://docs.cerbos.dev/cerbos/latest/policies/scoped_policies
- [R5] https://docs.cerbos.dev/cerbos/latest/policies/conditions
- [R6] https://docs.cerbos.dev/cerbos/latest/policies/derived_roles
- [R7] https://docs.cerbos.dev/cerbos/latest/policies/evaluation
- [R8] https://docs.cerbos.dev/cerbos/latest/policies/best_practices
- [R9] https://docs.cerbos.dev/cerbos/latest/api/
- [R10] https://docs.cerbos.dev/cerbos/latest/recipes/query-plan-adapters
- [R11] https://docs.cerbos.dev/cerbos/latest/configuration/audit and https://docs.cerbos.dev/cerbos/latest/tutorial/09_integrating-cerbos
- [R12] https://docs.cerbos.dev/cerbos/latest/policies/compile
- [R13] https://github.com/cerbos/cerbos (GitHub)
- [R14] https://docs.cerbos.dev/cerbos/latest/policies/schemas

Casbin (docs moved to casbin.apache.org)
- [B1] https://casbin.apache.org/docs/service/
- [B2] https://casbin.apache.org/docs/adapters/
- [B3] https://casbin.apache.org/docs/watchers/
- [B4] https://casbin.apache.org/docs/syntax-for-models/
- [B5] https://casbin.apache.org/docs/go-abac-tutorial/
- [B6] https://casbin.apache.org/docs/effector/
- [B7] https://casbin.apache.org/docs/rbac/
- [B8] https://casbin.apache.org/docs/rbac-api/
- [B9] https://casbin.apache.org/docs/model-storage/
- [B10] https://casbin.apache.org/docs/benchmark/
- [B11] https://casbin.apache.org/docs/online-editor/
- [B12] https://casbin.apache.org/docs/supported-models/

CASL (quotes taken from the markdown that builds casl.js.org; the site is client-rendered)
- [L1] https://casl.js.org/v7/en/guide/intro/
- [L2] https://casl.js.org/v7/en/cookbook/roles-with-persisted-permissions/
- [L3] https://casl.js.org/v7/en/cookbook/cache-rules/
- [L4] https://casl.js.org/v7/en/guide/define-rules/
- [L5] https://casl.js.org/v7/en/guide/conditions-in-depth/
- [L6] https://casl.js.org/v7/en/advanced/ability-to-database-query/
- [L7] https://casl.js.org/v7/en/package/casl-prisma/
- [L8] https://casl.js.org/v7/en/advanced/debugging-testing/

OPA
- [A1] https://www.openpolicyagent.org/docs/integration
- [A2] https://www.openpolicyagent.org/docs/wasm
- [A3] https://www.openpolicyagent.org/docs/management-bundles
- [A4] https://www.openpolicyagent.org/docs/rest-api
- [A5] https://www.openpolicyagent.org/docs/policy-language
- [A6] https://www.openpolicyagent.org/docs/errors/rego-recursion-error/rule-name-is-recursive
- [A7] https://www.openpolicyagent.org/docs/philosophy
- [A8] https://www.openpolicyagent.org/docs/management-decision-logs
- [A9] https://www.openpolicyagent.org/docs/policy-performance
- [A10] https://www.openpolicyagent.org/docs/policy-testing
