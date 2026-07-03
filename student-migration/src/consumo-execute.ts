import type {
  ConsumoPreparedRun,
  ConsumoRunPlan,
  PlannedMemberOperation,
} from "./consumo-plan";
import type {
  CourseMapResponse,
  CreatedAccessGroup,
  FindOrCreateMemberResult,
  TetraApiError as TetraApiErrorType,
} from "./tetra-api";
import { TetraApiError } from "./tetra-api";

export type ConsumoIamClient = {
  findOrCreateMembers(input: {
    tenantId: string;
    members: Array<{ email: string; name?: string }>;
  }): Promise<FindOrCreateMemberResult[]>;
};

export type ConsumoEnrollmentsClient = {
  getAccessGroup(accessGroupId: string): Promise<unknown | null>;
  createAccessGroup(input: {
    name: string;
    periodicity?: "DAILY" | "MONTHLY" | "YEARLY";
    periodicityValue?: number;
  }): Promise<CreatedAccessGroup>;
  listAccessGroupProducts(accessGroupId: string): Promise<unknown[]>;
  addAccessGroupProduct(input: {
    accessGroupId: string;
    productId: string;
    productType: "COURSE";
  }): Promise<unknown>;
  addAccessGroupMember(input: {
    accessGroupId: string;
    userId: string;
    name: string;
    email: string;
  }): Promise<unknown>;
  findExistingEnrollment(input: { userId: string; productId: string }): Promise<unknown | null>;
  createManualEnrollment(input: {
    userId: string;
    userName?: string;
    userEmail?: string;
    productId: string;
    accessStartsAt: string;
    accessEndsAt: string;
  }): Promise<unknown>;
  markLessonCompletedInternal(input: {
    lessonId: string;
    userId: string;
    courseId: string;
    occurredAt: string;
    productId?: string;
  }): Promise<{ alreadyCompleted: boolean }>;
};

export type ConsumoProductsClient = {
  getCourseMap(): Promise<CourseMapResponse>;
};

/**
 * Memoria local de grupos criados pela migracao (ledger). Garante que um
 * rerun do mesmo perfil "create" reutilize o grupo em vez de duplicar.
 */
export type AccessGroupStore = {
  findCreatedAccessGroup(tenantId: string, name: string): string | undefined;
  recordCreatedAccessGroup(tenantId: string, name: string, accessGroupId: string): void;
};

export type ConsumoExecutionClients = {
  iam: ConsumoIamClient;
  enrollments: ConsumoEnrollmentsClient;
  products?: ConsumoProductsClient;
  accessGroupStore?: AccessGroupStore;
};

export type ConsumoOperationResult = {
  operationId: string;
  memberRef: string;
  status: "succeeded" | "partial" | "failed" | "skipped";
  errorCode?: string;
  enrollments: Array<{
    productId: string;
    status: "created" | "already_exists" | "failed";
    errorCode?: string;
  }>;
  progress: Array<{
    lessonId: string;
    status: "created" | "already_completed" | "failed";
    errorCode?: string;
  }>;
};

export type ConsumoExecuteReport = {
  runId: string;
  executedAt: string;
  adapter: "fake" | "tetra-dev";
  layout: "themembers-consumo";
  tenantId: string;
  environment: ConsumoRunPlan["environment"];
  accessGroup: {
    id: string;
    name: string;
    created: boolean;
    reusedFromLedger: boolean;
  };
  summary: {
    memberOperations: number;
    membersEnsured: number;
    membersFailed: number;
    enrollmentsCreated: number;
    enrollmentsExisting: number;
    enrollmentsFailed: number;
    progressWritesCreated: number;
    progressAlreadyCompleted: number;
    progressFailed: number;
    blockedRows: number;
    progressOnlyBlockedRows: number;
  };
  results: ConsumoOperationResult[];
};

export type ConsumoPreflightCheck = {
  check:
    | "access_group"
    | "catalog_route"
    | "planned_products_in_catalog"
    | "planned_products_in_group";
  status: "ok" | "warning" | "failed";
  detail: string;
};

export type ConsumoPreflightReport = {
  runId: string;
  checkedAt: string;
  adapter: "tetra-dev";
  layout: "themembers-consumo";
  tenantId: string;
  environment: ConsumoRunPlan["environment"];
  summary: { ok: number; warnings: number; failures: number };
  checks: ConsumoPreflightCheck[];
};

const PROGRESS_CONCURRENCY = 6;
const RETRYABLE_ATTEMPTS = 3;

export async function preflightConsumoRun(
  prepared: ConsumoPreparedRun,
  clients: ConsumoExecutionClients,
  now = new Date(),
): Promise<ConsumoPreflightReport> {
  const { plan } = prepared;
  const checks: ConsumoPreflightCheck[] = [];
  const plannedProductIds = collectPlannedProductIds(plan);

  if (plan.accessGroup.mode === "existing") {
    const group = await clients.enrollments.getAccessGroup(plan.accessGroup.id);
    checks.push(
      group
        ? { check: "access_group", status: "ok", detail: `access group ${plan.accessGroup.id} exists` }
        : {
            check: "access_group",
            status: "failed",
            detail: `access group ${plan.accessGroup.id} not found`,
          },
    );

    if (group) {
      const attached = new Set(
        (await clients.enrollments.listAccessGroupProducts(plan.accessGroup.id))
          .map(extractProductId)
          .filter((id): id is string => Boolean(id)),
      );
      const missing = plannedProductIds.filter((productId) => !attached.has(productId));
      checks.push(
        missing.length === 0
          ? {
              check: "planned_products_in_group",
              status: "ok",
              detail: "all planned products attached to the access group",
            }
          : {
              check: "planned_products_in_group",
              status: "warning",
              detail: `${missing.length} planned product(s) not attached yet (execute will attach): ${missing.join(", ")}`,
            },
      );
    }
  } else {
    const reusedId = clients.accessGroupStore?.findCreatedAccessGroup(
      plan.tenantId,
      plan.accessGroup.name,
    );
    checks.push({
      check: "access_group",
      status: "ok",
      detail: reusedId
        ? `access group "${plan.accessGroup.name}" already created by a previous run (${reusedId})`
        : `access group "${plan.accessGroup.name}" will be created on execute`,
    });
  }

  if (clients.products) {
    try {
      const courseMap = await clients.products.getCourseMap();
      checks.push({
        check: "catalog_route",
        status: "ok",
        detail: `internal catalog route reachable (${courseMap.products.length} course products)`,
      });

      const catalogProductIds = new Set(courseMap.products.map((product) => product.productId));
      const missing = plannedProductIds.filter((productId) => !catalogProductIds.has(productId));
      checks.push(
        missing.length === 0
          ? {
              check: "planned_products_in_catalog",
              status: "ok",
              detail: "all planned products present in the live catalog",
            }
          : {
              check: "planned_products_in_catalog",
              status: "failed",
              detail: `planned product(s) missing from live catalog: ${missing.join(", ")}`,
            },
      );
    } catch (error) {
      checks.push({
        check: "catalog_route",
        status: "failed",
        detail: `internal catalog route failed: ${describeError(error)}`,
      });
    }
  }

  return {
    runId: plan.runId,
    checkedAt: now.toISOString(),
    adapter: "tetra-dev",
    layout: plan.layout,
    tenantId: plan.tenantId,
    environment: plan.environment,
    summary: {
      ok: checks.filter((check) => check.status === "ok").length,
      warnings: checks.filter((check) => check.status === "warning").length,
      failures: checks.filter((check) => check.status === "failed").length,
    },
    checks,
  };
}

export function executeConsumoFake(plan: ConsumoRunPlan, now = new Date()): ConsumoExecuteReport {
  const results: ConsumoOperationResult[] = plan.operations.map((operation) => ({
    operationId: operation.operationId,
    memberRef: `member_${operation.member.memberHash.slice(0, 12)}`,
    status: "succeeded",
    enrollments: operation.enrollments.map((enrollment) => ({
      productId: enrollment.productId,
      status: "created",
    })),
    progress: operation.progressWrites.map((write) => ({
      lessonId: write.lessonId,
      status: "created",
    })),
  }));

  return buildReport(plan, "fake", now, results, {
    id: plan.accessGroup.mode === "existing" ? plan.accessGroup.id : "fake-access-group",
    name: accessGroupName(plan),
    created: plan.accessGroup.mode === "create",
    reusedFromLedger: false,
  });
}

export async function executeConsumoRun(
  prepared: ConsumoPreparedRun,
  clients: ConsumoExecutionClients,
  now = new Date(),
): Promise<ConsumoExecuteReport> {
  const { plan, privateContext } = prepared;
  const group = await ensureAccessGroup(plan, clients);
  await ensureGroupProducts(plan, group.id, clients);

  const membersByOperation = new Map(
    privateContext.members.map((member) => [member.operationId, member]),
  );

  const iamResults = await clients.iam.findOrCreateMembers({
    tenantId: plan.tenantId,
    members: privateContext.members.map((member) => ({
      email: member.email,
      ...(member.name ? { name: member.name } : {}),
    })),
  });
  const userIdByEmail = new Map<string, string | null>(
    iamResults.map((result) => [result.email.toLowerCase(), result.userId]),
  );

  const results: ConsumoOperationResult[] = [];
  for (const operation of plan.operations) {
    results.push(
      await executeMemberOperation(plan, group.id, operation, membersByOperation, userIdByEmail, clients),
    );
  }

  return buildReport(plan, "tetra-dev", now, results, group);
}

async function executeMemberOperation(
  plan: ConsumoRunPlan,
  accessGroupId: string,
  operation: PlannedMemberOperation,
  membersByOperation: Map<string, { operationId: string; email: string; name?: string }>,
  userIdByEmail: Map<string, string | null>,
  clients: ConsumoExecutionClients,
): Promise<ConsumoOperationResult> {
  const member = membersByOperation.get(operation.operationId);
  if (!member) {
    return {
      operationId: operation.operationId,
      memberRef: `member_${operation.member.memberHash.slice(0, 12)}`,
      status: "failed",
      errorCode: "PRIVATE_CONTEXT_MISSING",
      enrollments: [],
      progress: [],
    };
  }

  const userId = userIdByEmail.get(member.email.toLowerCase());
  if (!userId) {
    return {
      operationId: operation.operationId,
      memberRef: `member_${operation.member.memberHash.slice(0, 12)}`,
      status: "failed",
      errorCode: "IAM_MEMBER_NOT_RESOLVED",
      enrollments: [],
      progress: [],
    };
  }

  const memberRef = `tetra_user_${userId}`;

  try {
    await addMemberIdempotent(clients, {
      accessGroupId,
      userId,
      name: member.name ?? member.email,
      email: member.email,
    });
  } catch (error) {
    return {
      operationId: operation.operationId,
      memberRef,
      status: "failed",
      errorCode: `GROUP_MEMBERSHIP_FAILED:${describeError(error)}`,
      enrollments: [],
      progress: [],
    };
  }

  const enrollments: ConsumoOperationResult["enrollments"] = [];
  const enrolledCourseIds = new Set<string>();
  for (const enrollment of operation.enrollments) {
    try {
      const existing = await clients.enrollments.findExistingEnrollment({
        userId,
        productId: enrollment.productId,
      });
      if (existing) {
        enrollments.push({ productId: enrollment.productId, status: "already_exists" });
        enrolledCourseIds.add(enrollment.courseId);
        continue;
      }

      await withRetry(() =>
        clients.enrollments.createManualEnrollment({
          userId,
          // A rota interna exige nome; membros sem nome usam o email.
          userName: member.name || member.email,
          userEmail: member.email,
          productId: enrollment.productId,
          accessStartsAt: enrollment.accessStartsAt,
          accessEndsAt: enrollment.accessEndsAt,
        }),
      );
      enrollments.push({ productId: enrollment.productId, status: "created" });
      enrolledCourseIds.add(enrollment.courseId);
    } catch (error) {
      enrollments.push({
        productId: enrollment.productId,
        status: "failed",
        errorCode: describeError(error),
      });
    }
  }

  const progress = await runWithConcurrency(
    operation.progressWrites,
    PROGRESS_CONCURRENCY,
    async (write) => {
      if (!enrolledCourseIds.has(write.courseId)) {
        return {
          lessonId: write.lessonId,
          status: "failed" as const,
          errorCode: "ENROLLMENT_NOT_ENSURED",
        };
      }

      try {
        const result = await withRetry(() =>
          clients.enrollments.markLessonCompletedInternal({
            lessonId: write.lessonId,
            userId,
            courseId: write.courseId,
            occurredAt: write.occurredAt,
            productId: write.productId,
          }),
        );
        return {
          lessonId: write.lessonId,
          status: result.alreadyCompleted ? ("already_completed" as const) : ("created" as const),
        };
      } catch (error) {
        return {
          lessonId: write.lessonId,
          status: "failed" as const,
          errorCode: describeError(error),
        };
      }
    },
  );

  const hasFailure =
    enrollments.some((enrollment) => enrollment.status === "failed") ||
    progress.some((write) => write.status === "failed");
  const hasSuccess =
    enrollments.some((enrollment) => enrollment.status !== "failed") ||
    progress.some((write) => write.status !== "failed");

  return {
    operationId: operation.operationId,
    memberRef,
    status: hasFailure ? (hasSuccess ? "partial" : "failed") : "succeeded",
    enrollments,
    progress,
  };
}

async function ensureAccessGroup(
  plan: ConsumoRunPlan,
  clients: ConsumoExecutionClients,
): Promise<ConsumoExecuteReport["accessGroup"]> {
  if (plan.accessGroup.mode === "existing") {
    const group = await clients.enrollments.getAccessGroup(plan.accessGroup.id);
    if (!group) {
      throw new Error(`Access group ${plan.accessGroup.id} not found.`);
    }
    return {
      id: plan.accessGroup.id,
      name: plan.accessGroup.name ?? plan.accessGroup.id,
      created: false,
      reusedFromLedger: false,
    };
  }

  const { name, periodicity, periodicityValue } = plan.accessGroup;
  const reusedId = clients.accessGroupStore?.findCreatedAccessGroup(plan.tenantId, name);
  if (reusedId) {
    const group = await clients.enrollments.getAccessGroup(reusedId);
    if (group) {
      return { id: reusedId, name, created: false, reusedFromLedger: true };
    }
  }

  const created = await clients.enrollments.createAccessGroup({
    name,
    periodicity,
    periodicityValue,
  });
  clients.accessGroupStore?.recordCreatedAccessGroup(plan.tenantId, name, created.id);
  return { id: created.id, name: created.name, created: true, reusedFromLedger: false };
}

async function ensureGroupProducts(
  plan: ConsumoRunPlan,
  accessGroupId: string,
  clients: ConsumoExecutionClients,
): Promise<void> {
  const attached = new Set(
    (await clients.enrollments.listAccessGroupProducts(accessGroupId))
      .map(extractProductId)
      .filter((id): id is string => Boolean(id)),
  );

  for (const productId of collectPlannedProductIds(plan)) {
    if (attached.has(productId)) {
      continue;
    }

    try {
      await clients.enrollments.addAccessGroupProduct({
        accessGroupId,
        productId,
        productType: "COURSE",
      });
    } catch (error) {
      if (isConflictError(error)) {
        continue;
      }
      throw error;
    }
  }
}

async function addMemberIdempotent(
  clients: ConsumoExecutionClients,
  input: { accessGroupId: string; userId: string; name: string; email: string },
): Promise<void> {
  try {
    await clients.enrollments.addAccessGroupMember(input);
  } catch (error) {
    if (isConflictError(error)) {
      return;
    }
    throw error;
  }
}

function buildReport(
  plan: ConsumoRunPlan,
  adapter: ConsumoExecuteReport["adapter"],
  now: Date,
  results: ConsumoOperationResult[],
  accessGroup: ConsumoExecuteReport["accessGroup"],
): ConsumoExecuteReport {
  const enrollmentResults = results.flatMap((result) => result.enrollments);
  const progressResults = results.flatMap((result) => result.progress);

  return {
    runId: plan.runId,
    executedAt: now.toISOString(),
    adapter,
    layout: plan.layout,
    tenantId: plan.tenantId,
    environment: plan.environment,
    accessGroup,
    summary: {
      memberOperations: plan.operations.length,
      membersEnsured: results.filter((result) => result.status !== "failed").length,
      membersFailed: results.filter((result) => result.status === "failed").length,
      enrollmentsCreated: enrollmentResults.filter((entry) => entry.status === "created").length,
      enrollmentsExisting: enrollmentResults.filter((entry) => entry.status === "already_exists")
        .length,
      enrollmentsFailed: enrollmentResults.filter((entry) => entry.status === "failed").length,
      progressWritesCreated: progressResults.filter((entry) => entry.status === "created").length,
      progressAlreadyCompleted: progressResults.filter(
        (entry) => entry.status === "already_completed",
      ).length,
      progressFailed: progressResults.filter((entry) => entry.status === "failed").length,
      blockedRows: plan.source.blockedRows,
      progressOnlyBlockedRows: plan.source.progressOnlyBlockedRows,
    },
    results,
  };
}

function collectPlannedProductIds(plan: ConsumoRunPlan): string[] {
  const ids = new Set<string>();
  for (const operation of plan.operations) {
    for (const enrollment of operation.enrollments) {
      ids.add(enrollment.productId);
    }
  }
  return Array.from(ids).sort();
}

function accessGroupName(plan: ConsumoRunPlan): string {
  return plan.accessGroup.mode === "existing"
    ? (plan.accessGroup.name ?? plan.accessGroup.id)
    : plan.accessGroup.name;
}

function extractProductId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const value = record.productId ?? record.product_id ?? record.id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isConflictError(error: unknown): error is TetraApiErrorType {
  return error instanceof TetraApiError && error.status === 409;
}

function describeError(error: unknown): string {
  if (error instanceof TetraApiError) {
    return `${error.code}${error.status ? `_${error.status}` : ""}`;
  }
  return error instanceof Error ? error.message : "unknown error";
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRYABLE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === RETRYABLE_ATTEMPTS) {
        throw error;
      }
      await sleep(150 * attempt);
    }
  }
  throw lastError;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof TetraApiError) {
    return error.status === undefined || error.status >= 500;
  }
  return error instanceof TypeError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function drain(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => drain()),
  );
  return results;
}
