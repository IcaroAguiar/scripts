import { EXECUTE_ADAPTERS, type ExecuteOperationResult, type ExecuteReport } from "./execute";
import type { PrivateExecutionContext, RunPlan } from "./migration-plan";

type LegacyPreparedMigration = {
  plan: RunPlan;
  privateContext: PrivateExecutionContext;
};
import type {
  AddAccessGroupMemberInput,
  CreateEnrollmentClientInput,
  FindExistingEnrollmentInput,
  FindOrCreateMembersInput,
  FindOrCreateMemberResult,
} from "./tetra-api";

export type TetraDevExecutionClients = {
  iam: {
    findOrCreateMembers(input: FindOrCreateMembersInput): Promise<FindOrCreateMemberResult[]>;
  };
  enrollments: {
    getAccessGroup(accessGroupId: string): Promise<unknown | null>;
    listAccessGroupProducts(accessGroupId: string): Promise<unknown[]>;
    addAccessGroupMember(input: AddAccessGroupMemberInput): Promise<unknown>;
    findExistingEnrollment(input: FindExistingEnrollmentInput): Promise<unknown | null>;
    createEnrollment(input: CreateEnrollmentClientInput): Promise<unknown>;
  };
};

export type TetraDevPreflightClients = {
  enrollments: Pick<
    TetraDevExecutionClients["enrollments"],
    "getAccessGroup" | "listAccessGroupProducts"
  >;
};

export type TetraDevPreflightResult = {
  operationId: string;
  status: "ready" | "failed";
  sourceRefCount: number;
  memberRef: string;
  accessGroupId: string;
  productId: string;
  errorCode?: string;
};

export type TetraDevPreflightReport = {
  runId: string;
  checkedAt: string;
  adapter: typeof EXECUTE_ADAPTERS.tetraDev;
  tenantId: string;
  environment: string;
  summary: {
    checkedOperations: number;
    readyOperations: number;
    failedOperations: number;
    blockedRows: number;
  };
  results: TetraDevPreflightResult[];
};

export async function preflightTetraDevRun(
  prepared: LegacyPreparedMigration,
  clients: TetraDevPreflightClients,
  now = new Date(),
): Promise<TetraDevPreflightReport> {
  const preflightFailures = await preflightOperations(prepared, clients);
  const results = prepared.plan.operations.map((operation): TetraDevPreflightResult => {
    const errorCode = preflightFailures.get(operation.operationId);
    return {
      operationId: operation.operationId,
      status: errorCode ? "failed" : "ready",
      sourceRefCount: operation.sourceRefs.length,
      memberRef: operation.member.memberHash,
      accessGroupId: operation.accessGroup.id,
      productId: operation.product.id,
      ...(errorCode ? { errorCode } : {}),
    };
  });
  const failedOperations = results.filter((result) => result.status === "failed").length;

  return {
    runId: prepared.plan.runId,
    checkedAt: now.toISOString(),
    adapter: EXECUTE_ADAPTERS.tetraDev,
    tenantId: prepared.plan.tenantId,
    environment: prepared.plan.environment,
    summary: {
      checkedOperations: results.length,
      readyOperations: results.length - failedOperations,
      failedOperations,
      blockedRows: prepared.plan.blockedRows.length,
    },
    results,
  };
}

export async function executeTetraDevRun(
  prepared: LegacyPreparedMigration,
  clients: TetraDevExecutionClients,
  now = new Date(),
): Promise<ExecuteReport> {
  const privateOperationsById = new Map(
    prepared.privateContext.operations.map((operation) => [operation.operationId, operation]),
  );
  const preflightFailures = await preflightOperations(prepared, clients);
  const members = uniqueMembers(
    prepared.privateContext.operations
      .filter((operation) => !preflightFailures.has(operation.operationId))
      .map((operation) => operation.member),
  );
  const memberResults =
    members.length > 0
      ? await clients.iam.findOrCreateMembers({
          tenantId: prepared.privateContext.tenantId,
          members,
        })
      : [];
  const memberResultsByEmail = new Map(
    memberResults.map((result) => [result.email.trim().toLowerCase(), result]),
  );

  const results: ExecuteOperationResult[] = [];
  for (const operation of prepared.plan.operations) {
    const preflightError = preflightFailures.get(operation.operationId);
    if (preflightError) {
      results.push({
        operationId: operation.operationId,
        status: "failed",
        sourceRefCount: operation.sourceRefs.length,
        memberRef: operation.member.memberHash,
        accessGroupId: operation.accessGroup.id,
        productId: operation.product.id,
        progressWritePlanned: false,
        errorCode: preflightError,
      });
      continue;
    }

    const privateOperation = privateOperationsById.get(operation.operationId);
    const memberResult = privateOperation
      ? memberResultsByEmail.get(privateOperation.member.email)
      : undefined;

    if (!privateOperation || !memberResult?.userId || memberResult.error) {
      results.push({
        operationId: operation.operationId,
        status: "failed",
        sourceRefCount: operation.sourceRefs.length,
        memberRef: operation.member.memberHash,
        accessGroupId: operation.accessGroup.id,
        productId: operation.product.id,
        progressWritePlanned: false,
        errorCode: memberResult?.error ?? "MEMBER_RESOLUTION_FAILED",
      });
      continue;
    }

    try {
      await clients.enrollments.addAccessGroupMember({
        accessGroupId: operation.accessGroup.id,
        userId: memberResult.userId,
        name: privateOperation.member.name ?? privateOperation.member.email,
        email: privateOperation.member.email,
      });

      const existingEnrollment = await clients.enrollments.findExistingEnrollment({
        userId: memberResult.userId,
        productId: operation.product.id,
        accessGroupId: operation.accessGroup.id,
      });

      if (!existingEnrollment) {
        await clients.enrollments.createEnrollment({
          userId: memberResult.userId,
          userEmail: privateOperation.member.email,
          productId: operation.product.id,
          productName: operation.product.name,
          productType: operation.product.type,
          accessGroupId: operation.accessGroup.id,
          ...(privateOperation.member.name ? { userName: privateOperation.member.name } : {}),
          ...(operation.product.courseId ? { courseId: operation.product.courseId } : {}),
        });
      }

      results.push({
        operationId: operation.operationId,
        status: "succeeded",
        sourceRefCount: operation.sourceRefs.length,
        memberRef: `tetra_user_${memberResult.userId}`,
        accessGroupId: operation.accessGroup.id,
        productId: operation.product.id,
        progressWritePlanned: false,
      });
    } catch {
      results.push({
        operationId: operation.operationId,
        status: "failed",
        sourceRefCount: operation.sourceRefs.length,
        memberRef: `tetra_user_${memberResult.userId}`,
        accessGroupId: operation.accessGroup.id,
        productId: operation.product.id,
        progressWritePlanned: false,
        errorCode: "TETRA_DEV_OPERATION_FAILED",
      });
    }
  }

  const failedOperations = results.filter((result) => result.status === "failed").length;

  return {
    runId: prepared.plan.runId,
    executedAt: now.toISOString(),
    adapter: EXECUTE_ADAPTERS.tetraDev,
    tenantId: prepared.plan.tenantId,
    environment: prepared.plan.environment,
    source: prepared.plan.source,
    summary: {
      attemptedOperations: results.length,
      succeededOperations: results.length - failedOperations,
      failedOperations,
      skippedBlockedRows: prepared.plan.blockedRows.length,
      progressWrites: 0,
    },
    results,
  };
}

async function preflightOperations(
  prepared: LegacyPreparedMigration,
  clients: TetraDevPreflightClients,
): Promise<Map<string, string>> {
  const failures = new Map<string, string>();

  for (const operation of prepared.plan.operations) {
    const accessGroup = await clients.enrollments.getAccessGroup(operation.accessGroup.id);
    if (!accessGroup) {
      failures.set(operation.operationId, "ACCESS_GROUP_NOT_FOUND");
      continue;
    }

    const products = await clients.enrollments.listAccessGroupProducts(operation.accessGroup.id);
    if (!products.some((product) => hasProductId(product, operation.product.id))) {
      failures.set(operation.operationId, "PRODUCT_NOT_IN_ACCESS_GROUP");
    }
  }

  return failures;
}

function hasProductId(value: unknown, productId: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as { id?: unknown; productId?: unknown; product?: { id?: unknown } };
  return record.id === productId || record.productId === productId || record.product?.id === productId;
}

function uniqueMembers(
  members: Array<{
    email: string;
    name?: string;
  }>,
): Array<{
  email: string;
  name?: string;
}> {
  const byEmail = new Map<string, { email: string; name?: string }>();
  for (const member of members) {
    const email = member.email.trim().toLowerCase();
    if (!byEmail.has(email)) {
      byEmail.set(email, {
        email,
        ...(member.name ? { name: member.name } : {}),
      });
    }
  }
  return Array.from(byEmail.values());
}
