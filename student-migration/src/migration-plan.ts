import { createHash, randomUUID } from "node:crypto";
import type { CsvRow } from "./csv";

export type SourceRow = {
  sheetName: string;
  rowNumber: number;
  values: CsvRow;
};

export type ProductType = "COURSE" | "BUNDLE" | "CONSULTANCY" | "OTHER";

export type MappingProfile = {
  version: 1;
  name: string;
  tenantId: string;
  environment: "local" | "dev" | "staging" | "production";
  fields: {
    email: string;
    name?: string;
    phone?: string;
    accessGroup?: string;
    product?: string;
    course?: string;
    lesson?: string;
    progressPercent?: string;
    completed?: string;
    accessedAt?: string;
  };
  mappings: {
    accessGroups: Record<string, ResolvedAccessGroup>;
    products: Record<string, ResolvedProduct>;
  };
};

export type ResolvedAccessGroup = {
  id: string;
  name: string;
};

export type ResolvedProduct = {
  id: string;
  name: string;
  type: ProductType;
  courseId?: string;
};

export type RunPlan = {
  runId: string;
  generatedAt: string;
  dryRun: true;
  tenantId: string;
  environment: MappingProfile["environment"];
  source: {
    totalRows: number;
    executableRows: number;
    blockedRows: number;
    evidenceOnlyRows: number;
    duplicateRows: number;
  };
  operations: PlannedOperation[];
  blockedRows: BlockedRow[];
  evidenceOnlyRows: EvidenceOnlyRow[];
};

export type PreparedRun = {
  plan: RunPlan;
  privateContext: PrivateExecutionContext;
};

export type PrivateExecutionContext = {
  runId: string;
  tenantId: string;
  environment: MappingProfile["environment"];
  operations: PrivateOperationContext[];
};

export type PrivateOperationContext = {
  operationId: string;
  member: PrivateMemberInput;
};

export type PrivateMemberInput = {
  email: string;
  name?: string;
};

export type PlannedOperation = {
  operationId: string;
  sourceRefs: SourceRef[];
  member: RedactedMember;
  accessGroup: ResolvedAccessGroup;
  product: ResolvedProduct;
  idempotencyKey: string;
  action: "ensure_member_access_and_enrollment";
  evidence: ProgressEvidence;
};

export type SourceRef = {
  sheetName: string;
  rowNumber: number;
  rowHash: string;
};

export type RedactedMember = {
  memberHash: string;
  hasName: boolean;
  hasPhoneEvidence: boolean;
};

export type ProgressEvidence = {
  hasProgressPercent: boolean;
  hasCompletionFlag: boolean;
  hasHistoricalAccessDate: boolean;
  progressWritePlanned: false;
};

export type BlockedRow = {
  sourceRef: SourceRef;
  memberHash?: string;
  reasons: string[];
  evidence: ProgressEvidence;
};

export type EvidenceOnlyRow = {
  sourceRef: SourceRef;
  memberHash?: string;
  reason: string;
  evidence: ProgressEvidence;
};

export type ApprovalFile = {
  runId: string;
  tenantId: string;
  environment: MappingProfile["environment"];
  approvedAt: string;
};

export function csvRowsToSourceRows(rows: CsvRow[], sheetName = "csv"): SourceRow[] {
  return rows.map((values, index) => ({
    sheetName,
    rowNumber: index + 2,
    values,
  }));
}

export function buildRunPlan(
  rows: SourceRow[],
  profile: MappingProfile,
  now = new Date(),
  runId: string = randomUUID(),
): RunPlan {
  return buildPreparedRun(rows, profile, now, runId).plan;
}

export function buildPreparedRun(
  rows: SourceRow[],
  profile: MappingProfile,
  now = new Date(),
  runId: string = randomUUID(),
): PreparedRun {
  const operations = new Map<string, PlannedOperation>();
  const privateOperations = new Map<string, PrivateOperationContext>();
  const blockedRows: BlockedRow[] = [];
  const evidenceOnlyRows: EvidenceOnlyRow[] = [];
  let duplicateRows = 0;

  for (const row of rows) {
    const sourceRef = toSourceRef(row);
    const email = normalizeEmail(readMappedValue(row, profile.fields.email));
    const memberHash = email ? hashValue(email) : undefined;
    const member = buildRedactedMember(row, profile, memberHash);
    const evidence = buildProgressEvidence(row, profile);
    const reasons = validateRow(row, profile, email);

    const accessGroup = resolveMappedAccessGroup(row, profile);
    const product = resolveMappedProduct(row, profile);

    if (!accessGroup) {
      reasons.push("access group is missing or not mapped");
    }
    if (!product) {
      reasons.push("product is missing or not mapped");
    }

    if (reasons.length > 0) {
      blockedRows.push({
        sourceRef,
        ...(memberHash ? { memberHash } : {}),
        reasons,
        evidence,
      });
      continue;
    }

    if (!memberHash || !accessGroup || !product) {
      throw new Error("internal planning invariant violated");
    }

    const dedupeKey = `${memberHash}:${accessGroup.id}:${product.id}`;
    const existing = operations.get(dedupeKey);
    if (existing) {
      duplicateRows += 1;
      existing.sourceRefs.push(sourceRef);
      existing.evidence = mergeEvidence(existing.evidence, evidence);
      continue;
    }

    const operationId = hashValue(dedupeKey).slice(0, 20);
    operations.set(dedupeKey, {
      operationId,
      sourceRefs: [sourceRef],
      member,
      accessGroup,
      product,
      idempotencyKey: `student-migration:${runId}:${hashValue(dedupeKey).slice(0, 24)}`,
      action: "ensure_member_access_and_enrollment",
      evidence,
    });
    privateOperations.set(dedupeKey, {
      operationId,
      member: buildPrivateMemberInput(row, profile, email),
    });
  }

  const plan: RunPlan = {
    runId,
    generatedAt: now.toISOString(),
    dryRun: true,
    tenantId: profile.tenantId,
    environment: profile.environment,
    source: {
      totalRows: rows.length,
      executableRows: operations.size,
      blockedRows: blockedRows.length,
      evidenceOnlyRows: evidenceOnlyRows.length,
      duplicateRows,
    },
    operations: Array.from(operations.values()),
    blockedRows,
    evidenceOnlyRows,
  };

  return {
    plan,
    privateContext: {
      runId,
      tenantId: profile.tenantId,
      environment: profile.environment,
      operations: Array.from(privateOperations.values()),
    },
  };
}

export function assertExecutionAllowed(input: {
  execute: boolean;
  plan: Pick<RunPlan, "runId" | "tenantId" | "environment">;
  approval?: ApprovalFile;
}): void {
  if (!input.execute) {
    return;
  }

  if (input.plan.environment !== "production") {
    return;
  }

  if (!input.approval) {
    throw new Error("Production execute requires an approval file.");
  }

  if (
    input.approval.runId !== input.plan.runId ||
    input.approval.tenantId !== input.plan.tenantId ||
    input.approval.environment !== input.plan.environment
  ) {
    throw new Error("Production approval file does not match this run.");
  }
}

function validateRow(row: SourceRow, profile: MappingProfile, email: string): string[] {
  const reasons: string[] = [];
  if (!email) {
    reasons.push("email is required");
  } else if (!isValidEmail(email)) {
    reasons.push("email is invalid");
  }

  if (profile.fields.name && !normalizeText(readMappedValue(row, profile.fields.name))) {
    reasons.push("name is missing");
  }

  return reasons;
}

function resolveMappedAccessGroup(
  row: SourceRow,
  profile: MappingProfile,
): ResolvedAccessGroup | undefined {
  const field = profile.fields.accessGroup;
  if (!field) return undefined;
  const label = normalizeLabel(readMappedValue(row, field));
  return label ? profile.mappings.accessGroups[label] : undefined;
}

function resolveMappedProduct(row: SourceRow, profile: MappingProfile): ResolvedProduct | undefined {
  const field = profile.fields.product;
  if (!field) return undefined;
  const label = normalizeLabel(readMappedValue(row, field));
  return label ? profile.mappings.products[label] : undefined;
}

function buildRedactedMember(
  row: SourceRow,
  profile: MappingProfile,
  memberHash: string | undefined,
): RedactedMember {
  return {
    memberHash: memberHash ?? hashValue(`missing-email:${row.sheetName}:${row.rowNumber}`),
    hasName: profile.fields.name
      ? normalizeText(readMappedValue(row, profile.fields.name)).length > 0
      : false,
    hasPhoneEvidence: profile.fields.phone
      ? normalizeText(readMappedValue(row, profile.fields.phone)).length > 0
      : false,
  };
}

function buildPrivateMemberInput(
  row: SourceRow,
  profile: MappingProfile,
  email: string,
): PrivateMemberInput {
  const name = profile.fields.name
    ? normalizeText(readMappedValue(row, profile.fields.name))
    : undefined;

  return {
    email,
    ...(name ? { name } : {}),
  };
}

function buildProgressEvidence(row: SourceRow, profile: MappingProfile): ProgressEvidence {
  return {
    hasProgressPercent: profile.fields.progressPercent
      ? normalizeText(readMappedValue(row, profile.fields.progressPercent)).length > 0
      : false,
    hasCompletionFlag: profile.fields.completed
      ? normalizeText(readMappedValue(row, profile.fields.completed)).length > 0
      : false,
    hasHistoricalAccessDate: profile.fields.accessedAt
      ? normalizeText(readMappedValue(row, profile.fields.accessedAt)).length > 0
      : false,
    progressWritePlanned: false,
  };
}

function mergeEvidence(left: ProgressEvidence, right: ProgressEvidence): ProgressEvidence {
  return {
    hasProgressPercent: left.hasProgressPercent || right.hasProgressPercent,
    hasCompletionFlag: left.hasCompletionFlag || right.hasCompletionFlag,
    hasHistoricalAccessDate: left.hasHistoricalAccessDate || right.hasHistoricalAccessDate,
    progressWritePlanned: false,
  };
}

export function toSourceRef(row: SourceRow): SourceRef {
  return {
    sheetName: row.sheetName,
    rowNumber: row.rowNumber,
    rowHash: hashValue(JSON.stringify(row.values)),
  };
}

function readMappedValue(row: SourceRow, field: string): string {
  return row.values[field] ?? "";
}

export function normalizeEmail(value: string): string {
  return normalizeText(value).toLowerCase();
}

export function normalizeLabel(value: string): string {
  return normalizeText(value).toLowerCase();
}

export function normalizeText(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
