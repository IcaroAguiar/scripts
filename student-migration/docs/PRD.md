# PRD: Tetra Member Migration CLI

## Problem Statement

Tetra needs to migrate members in bulk from spreadsheets whose layouts vary by source system. These spreadsheets may contain member identity data, access group information, product/course labels, enrollment intent, and historical progress evidence. Today, this work is risky because source columns are inconsistent, human-readable labels do not map directly to Tetra IDs, and production writes can create users, send notifications, grant access, and create enrollments.

The team needs a local, auditable CLI that turns spreadsheet inputs into a safe migration run: validate first, show exactly what will happen, block ambiguous rows, execute only approved valid operations, and keep sensitive data out of committed artifacts.

## Solution

Build a Bun + TypeScript CLI under the umbrella scripts repo for Tetra member migration. The CLI will accept CSV and XLSX inputs, map them through approved local profiles, produce a redacted dry-run plan, and execute valid operations only after explicit approval.

V1 will reuse existing Tetra contracts. It will use OAuth service-to-service for IAM user resolution/creation, and current `x-tenant-id` compatible endpoints for product lookup, access groups, enrollments, and related reads where OAuth service-to-service is not yet available end to end. The CLI will not create new backend endpoints.

V1 will not write historical progress. Progress and completion columns remain evidence in dry-run reports and ledgers because the current HTTP progress route cannot preserve historical dates.

## User Stories

1. As an operator, I want to import a CSV file, so that I can validate a migration source before touching Tetra services.
2. As an operator, I want to import an XLSX workbook, so that I can handle client-provided spreadsheets without manual conversion.
3. As an operator, I want each spreadsheet tab to represent one semantic input type, so that mixed layouts can be reasoned about safely.
4. As an operator, I want the CLI to infer candidate column mappings, so that I can prepare variable source formats quickly.
5. As an operator, I want to approve and reuse mapping profiles locally, so that repeated client imports are consistent.
6. As an operator, I want profiles with real tenant/product/group IDs to stay out of Git, so that client-specific operational data is not published.
7. As an operator, I want source labels such as "Aluno" to map to the canonical Tetra concept "Membro", so that domain language stays consistent.
8. As an operator, I want invalid emails to be blocked in dry-run, so that IAM calls do not fail late.
9. As an operator, I want duplicate source rows to be deduplicated by member, group, and product, so that lesson-level snapshots do not create repeated writes.
10. As an operator, I want ambiguous product/course/group labels to block the affected rows, so that the CLI never grants access to the wrong place.
11. As an operator, I want product and course labels resolved through existing catalog/overview APIs, so that the migration targets real Tetra IDs.
12. As an operator, I want user creation to use the existing IAM batch endpoint, so that V1 reuses the production-supported provisioning path.
13. As an operator, I want the CLI to pass names to IAM when available, so that newly created members have useful profile names.
14. As an operator, I want phone and extra profile details reported as evidence only, so that V1 does not write outside the approved S2S contract.
15. As an operator, I want to know when IAM will create new members and send notifications, so that the customer communication plan is ready before execute.
16. As an operator, I want access group membership to use idempotency keys, so that reruns are safe.
17. As an operator, I want enrollment creation to treat already-existing matching enrollments as idempotent success, so that reruns do not become noisy failures.
18. As an operator, I want suspended or expired enrollments to remain unchanged by default, so that migration does not unexpectedly reactivate access.
19. As an operator, I want progress columns included in dry-run evidence, so that historical data is not lost even when V1 does not write it.
20. As an operator, I want production execute to require a local approval file, so that production writes cannot happen by accident.
21. As an operator, I want `.env` support for local credentials and URLs, so that I can run the CLI ergonomically without committing secrets.
22. As an operator, I want redacted ledgers and reports, so that local artifacts do not duplicate sensitive names and emails.
23. As an operator, I want the source spreadsheet to remain the only full-PII artifact, so that retention and cleanup are easier.
24. As an operator, I want dry-run output to separate valid, blocked, and evidence-only rows, so that review is fast.
25. As an operator, I want execute to process valid rows even when some rows are blocked, so that partial clean migrations can move forward.
26. As an operator, I want every external call to be correlated to a run ID, so that failures are traceable.
27. As an operator, I want retry-safe behavior, so that transient API errors can be rerun without duplicating users or access.
28. As an operator, I want reports to identify missing mappings without exposing PII, so that the mapping profile can be corrected safely.
29. As a Tetra engineer, I want deep modules with stable interfaces, so that parsing, mapping, planning, and execution can be tested independently.
30. As a Tetra engineer, I want V1 to avoid backend changes, so that the migration tool can ship independently of service deployments.
31. As a Tetra engineer, I want the code to encode current remote API constraints, so that local stale branches do not mislead implementation.
32. As a reviewer, I want the PRD and technical plan in the repo, so that implementation agents can work from the same decisions.

## Implementation Decisions

- Build a local Bun + TypeScript CLI in the `student-migration` project.
- Keep the canonical person term as "Membro"; "Aluno" is source-system wording.
- Support CSV and XLSX inputs in V1.
- Treat one worksheet as one semantic input type.
- Use approved local mapping profiles for variable spreadsheet layouts.
- Keep real client mapping profiles local and gitignored.
- Use redacted dry-run reports and a SQLite ledger for run state.
- Use `.env` local configuration for service URLs and credentials, with an example file that contains names only, not secret values.
- Reuse the existing IAM service-token flow and `find-or-create-batch` endpoint for user resolution and creation.
- Accept the current IAM behavior that new members may receive notifications.
- Do not create new backend endpoints for V1.
- Use the existing hybrid execution path: OAuth service-to-service where available, and current `x-tenant-id` compatible endpoints where the remote service still depends on that compatibility.
- Block rows when group, product, course, or lesson labels do not resolve uniquely.
- Add members to resolved access groups before creating enrollments that reference those groups.
- Create enrollments only for products explicitly resolved from the spreadsheet, not for every product attached to the group.
- Treat matching existing enrollments as idempotent success.
- Do not reactivate suspended, canceled, or expired enrollments automatically.
- Do not write progress or completion in V1; keep progress evidence in reports and ledger.
- Do not write phone or extra details in V1; keep them as evidence and gap reporting.
- Allow partial execute: process valid rows and leave blocked rows pending.
- Require a production approval file containing run ID, tenant ID, and environment in addition to an execute flag.

## Testing Decisions

- Tests should validate external behavior: input files, normalized plans, blocked rows, redacted output, idempotency decisions, approval gates, and API-client request contracts.
- Parsing tests should cover CSV and XLSX fixtures with varied headers, whitespace, encoding, missing columns, duplicate rows, and multiple sheets.
- Mapping tests should cover alias suggestions, approved profiles, ambiguous labels, and blocked rows.
- Planner tests should cover deduplication by email, group, and product.
- Ledger tests should verify that no full name, email, or source row PII is stored in redacted artifacts.
- IAM client tests should verify service-token usage, chunking at the batch limit, name forwarding when available, and item-level failures.
- Products/enrollments client tests should verify request headers, tenant scoping, idempotency keys, and conflict-as-success behavior.
- Execute gate tests should prove production execution is blocked unless the approval file matches run ID, tenant ID, and environment.
- End-to-end tests should use local fixtures and fake API adapters; they must not require real Tetra credentials.
- The current `student-migration` test setup with Bun tests is the local prior art; expand from the existing parser/planner tests rather than introducing a separate test runner.

## Out of Scope

- Backend changes in IAM, enrollments, products, or tenants.
- New service-to-service endpoints.
- Writing historical progress or preserving historical completion dates.
- Updating phone, CPF, salary, education level, or other member details.
- Automatic creation of access groups from spreadsheet labels.
- Automatic creation of products, courses, modules, or lessons.
- Automatic reactivation of suspended, canceled, or expired enrollments.
- Publishing real client mapping profiles, ledgers, source spreadsheets, or PII fixtures to GitHub.
- A web UI.
- Production deploy automation.

## Further Notes

- The remote default branches showed that OAuth service-to-service is not accepted uniformly across all services. V1 intentionally documents and contains the hybrid path instead of pretending it is pure service-to-service end to end.
- Source spreadsheets are sensitive. The CLI must never print raw PII in normal logs, reports, or final summaries.
- The sample spreadsheet analyzed for planning was a lesson-progress snapshot, not a complete roster. V1 therefore treats lesson/progress rows as evidence unless they also resolve to access operations.
- This PRD is local by request and was not published to an issue tracker.
