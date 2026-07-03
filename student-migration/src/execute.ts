import type { PlannedOperation, RunPlan } from "./migration-plan";

export const EXECUTE_ADAPTERS = {
  fake: "fake",
  tetraDev: "tetra-dev",
} as const;

export type ExecuteAdapterName = (typeof EXECUTE_ADAPTERS)[keyof typeof EXECUTE_ADAPTERS];

export type ExecuteReport = {
  runId: string;
  executedAt: string;
  adapter: ExecuteAdapterName;
  tenantId: string;
  environment: RunPlan["environment"];
  source: RunPlan["source"];
  summary: {
    attemptedOperations: number;
    succeededOperations: number;
    failedOperations: number;
    skippedBlockedRows: number;
    progressWrites: 0;
  };
  results: ExecuteOperationResult[];
};

export type ExecuteOperationResult = {
  operationId: string;
  status: "succeeded" | "failed";
  sourceRefCount: number;
  memberRef: string;
  accessGroupId: string;
  productId: string;
  progressWritePlanned: false;
  errorCode?: string;
};

export function executeRun(
  plan: RunPlan,
  options: { adapter: ExecuteAdapterName; now?: Date },
): ExecuteReport {
  if (options.adapter !== EXECUTE_ADAPTERS.fake) {
    throw new Error("Only the fake execute adapter is available in this slice.");
  }

  const results = plan.operations.map((operation) => fakeExecuteOperation(operation));
  const failedOperations = results.filter((result) => result.status === "failed").length;

  return {
    runId: plan.runId,
    executedAt: (options.now ?? new Date()).toISOString(),
    adapter: options.adapter,
    tenantId: plan.tenantId,
    environment: plan.environment,
    source: plan.source,
    summary: {
      attemptedOperations: results.length,
      succeededOperations: results.length - failedOperations,
      failedOperations,
      skippedBlockedRows: plan.blockedRows.length,
      progressWrites: 0,
    },
    results,
  };
}

function fakeExecuteOperation(operation: PlannedOperation): ExecuteOperationResult {
  return {
    operationId: operation.operationId,
    status: "succeeded",
    sourceRefCount: operation.sourceRefs.length,
    memberRef: `fake_member_${operation.member.memberHash.slice(0, 12)}`,
    accessGroupId: operation.accessGroup.id,
    productId: operation.product.id,
    progressWritePlanned: false,
  };
}
