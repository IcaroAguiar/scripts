# Technical Plan: Tetra Member Migration

## Current Direction

V1 is a local migration CLI for bulk Tetra members from spreadsheets. It must support variable CSV/XLSX layouts, produce a redacted dry-run, and execute only validated access operations through existing Tetra APIs.

The tool intentionally reuses existing remote service behavior:

- IAM user resolution/creation uses OAuth `client_credentials` and the existing internal batch endpoint.
- Product, access group, enrollment, and progress-related reads/writes use existing endpoints. Where the current remote services do not accept `client_credentials`, V1 uses the existing `x-tenant-id` compatibility path.
- No backend endpoint changes are part of V1.

## Source Evidence

Remote branches were fetched and inspected because local Tetra repos may be stale or dirty. Analysis was based on `origin/main` for:

- `tetra-iam`
- `tetra-imports`
- `tetra-enrollments`
- `tetra-products`

Important constraints from remote code:

- IAM service token flow already exists through the dedicated service-token endpoint.
- IAM `find-or-create-batch` accepts `tenantId` and up to 500 users with `email` plus optional `name`.
- IAM provisioning creates or reactivates members and guarantees tenant member role.
- IAM provisioning may notify newly created members.
- Enrollments/products protected IAM routes expect `type=access`, not `type=client_credentials`.
- Some products and enrollments flows still allow `x-tenant-id` compatibility when no bearer token is provided.
- The progress HTTP route marks a lesson watched but does not expose `occurredAt`; V1 must not write historical progress.

## Canonical Language

- Use "Membro" for the imported person.
- Treat "Aluno" as wording from source systems, reports, or spreadsheet columns.
- Keep IAM tenant role separate from access-group role.
- Use "grupo de acesso", "produto", "curso", "matricula", "dry-run", "execute", "ledger", and "perfil de mapeamento" consistently.

## Data Model

### Source Row

Represents a raw spreadsheet row plus metadata:

- `sourceFileId`
- `sheetName`
- `rowNumber`
- `rawValues`
- `rowHash`

Raw source values are allowed in memory while processing, but not in redacted ledger output.

### Canonical Member Input

Normalized person-level data:

- normalized email
- optional display name
- optional source phone as evidence only
- optional external identifiers as evidence only

### Canonical Access Intent

Normalized access request:

- tenant ID from run config
- optional access group label or ID
- optional product/course/module/lesson labels
- source progress evidence
- source completion evidence
- source historical date evidence

### Resolved Operation

Executable operation after mapping:

- row references
- member hash
- user ID when resolved
- access group ID
- product ID
- product type
- course ID when relevant
- operation kind
- idempotency key
- blocking errors
- non-blocking evidence

## Deep Modules

### Input Readers

Stable interface:

- `readWorkbook(input): WorkbookRows`

Responsibilities:

- Read CSV and XLSX.
- Preserve sheet names and row numbers.
- Normalize header text only at the boundary.
- Avoid logging raw cell values.

### Mapping Profile Engine

Stable interface:

- `suggestProfile(workbook): ProfileSuggestion`
- `applyProfile(workbook, profile): CanonicalRows`
- `validateProfile(profile): ProfileValidation`

Responsibilities:

- Map source columns to canonical fields.
- Support aliases for common Portuguese and English headers.
- Keep approved profiles local.
- Separate schema/templates from real tenant/client IDs.

### Resolver

Stable interface:

- `resolveTargets(canonicalRows, lookupClients): ResolvedRows`

Responsibilities:

- Resolve products/courses/lessons through existing products overview APIs.
- Resolve access groups through existing enrollments APIs.
- Block ambiguous or missing mappings.
- Produce actionable mapping errors.

### Planner

Stable interface:

- `buildRunPlan(resolvedRows): RunPlan`

Responsibilities:

- Deduplicate by normalized email, resolved access group, and resolved product.
- Split rows into valid, blocked, and evidence-only.
- Mark progress-only rows as non-executable in V1.
- Compute idempotency keys.

### Ledger

Stable interface:

- `createRun(metadata): RunId`
- `recordDryRun(plan): void`
- `recordAttempt(operation): void`
- `recordResult(result): void`
- `loadRun(runId): RunState`

Responsibilities:

- Use SQLite.
- Store redacted row hashes and Tetra IDs.
- Avoid full email, full name, phone, and raw source rows.
- Support reruns and reconciliation.

### Tetra API Clients

Stable interfaces:

- `IamClient.findOrCreateMembers(batch): MemberResolution[]`
- `ProductsClient.findProductCandidates(query): ProductCandidate[]`
- `EnrollmentsClient.addAccessGroupMember(input): AccessGroupMemberResult`
- `EnrollmentsClient.createEnrollment(input): EnrollmentResult`
- `EnrollmentsClient.findExistingEnrollment(input): EnrollmentMatch | null`

Responsibilities:

- Encapsulate auth differences per service.
- Use service token for IAM.
- Use current `x-tenant-id` compatibility only where required.
- Keep request/response parsing explicit.
- Return domain-level errors, not raw fetch failures.

### Execute Orchestrator

Stable interface:

- `executeRun(plan, approval, clients): ExecuteReport`

Responsibilities:

- Enforce dry-run-first.
- Block production without approval file.
- Process only valid operations.
- Chunk IAM resolution at current batch limits.
- Apply access-group membership before enrollment.
- Treat confirmed existing enrollment as idempotent success.
- Avoid progress writes in V1.

### Report Writer

Stable interface:

- `writeDryRunReport(plan): ReportPaths`
- `writeExecuteReport(result): ReportPaths`

Responsibilities:

- Produce human-readable Markdown or JSON summaries.
- Keep reports redacted.
- Surface exact counts and blockers.
- Make mapping fixes obvious.

## Execution Flow

1. Load `.env` and validate required config.
2. Read CSV/XLSX.
3. Apply or suggest mapping profile.
4. Normalize source rows into canonical member/access intents.
5. Resolve groups and products against Tetra APIs.
6. Build redacted dry-run plan and ledger entry.
7. Stop unless execute is explicitly requested.
8. Validate approval file when target environment is production.
9. Resolve/create members in IAM.
10. Add members to access groups.
11. Create enrollments only for mapped products.
12. Reconcile existing enrollments as idempotent success.
13. Write redacted execute report.

## Blocking Rules

Block a row when:

- Email is missing or invalid.
- Required mapping profile fields are missing.
- Access group label does not resolve uniquely.
- Product/course/lesson label does not resolve uniquely.
- Product required by an operation is not attached/enabled for the resolved group.
- A write would require unsupported data mutation, such as progress history or member details.

Do not block the whole run only because some rows are blocked. Execute can process valid rows and report pending rows.

## Privacy Rules

- Do not print full PII in normal CLI output.
- Do not store full PII in SQLite ledger.
- Do not commit input spreadsheets.
- Do not commit generated `storage/`.
- Do not commit `.env`.
- Do not commit real mapping profiles with tenant/product/group/client IDs.
- Keep fixtures synthetic.

## Local Files

Versioned:

- README and usage docs.
- PRD.
- Technical plan.
- JSON schema or TypeScript type definitions for profiles.
- Example profiles with fake IDs.
- Synthetic CSV/XLSX fixtures.

Gitignored:

- `.env`
- `storage/`
- real mapping profiles
- source spreadsheets
- run ledgers
- execute reports from real runs

## Backlog

### Phase 1: Documentation and Contracts

- Update README to describe the Tetra member migration scope.
- Add `.env.example` with required variable names only.
- Define profile schema and fake example profile.
- Define redacted run-plan and report shapes.
- Define approval-file shape.

### Phase 2: Input and Mapping

- Add CSV parser support for flexible headers.
- Add XLSX reader.
- Add workbook/sheet abstraction.
- Add profile suggestion from aliases.
- Add approved-profile application.
- Add synthetic fixtures for variable sheet formats.

### Phase 3: Planning and Ledger

- Implement canonical row normalization.
- Implement row hashing and redaction helpers.
- Implement blocking rules.
- Implement deduplication by email + group + product.
- Implement SQLite ledger.
- Generate dry-run report.

### Phase 4: Tetra Clients

- Implement service-token provider.
- Implement IAM batch client with chunking and item-level error handling.
- Implement product/course overview lookup client.
- Implement access group lookup and mutation client.
- Implement enrollment create/list client.
- Normalize API errors into migration-domain errors.

### Phase 5: Execute

- Add execute mode behind explicit flag.
- Add production approval-file validation.
- Resolve/create members.
- Add access group members with idempotency keys.
- Create enrollments for resolved products.
- Treat matching existing enrollment as success.
- Keep progress writes disabled.
- Write redacted execute report.

### Phase 6: Verification

- Add unit tests for parsing, mapping, planning, redaction, ledger, and approval gates.
- Add fake-client integration tests for dry-run and execute.
- Add a smoke command using synthetic fixtures only.
- Add documentation for manual dry-run review.

## Acceptance Criteria

- A user can run a dry-run from a CSV or XLSX fixture without external API credentials.
- Dry-run output clearly separates valid, blocked, and evidence-only rows.
- No generated report or ledger stores full names, full emails, phone numbers, or raw source rows.
- Product/group ambiguity blocks affected rows.
- Execute cannot run in production without a matching approval file.
- IAM calls chunk users at the current batch limit.
- Existing matching enrollments are treated as idempotent success.
- Progress evidence is preserved in reports but no progress write is made.
- Real client profiles and generated run artifacts remain gitignored.
