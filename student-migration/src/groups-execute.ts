// Execucao idempotente do plano de grupos: cria/reusa cada grupo (ledger por
// nome, mesmo padrao do fluxo consumo), anexa os cursos resolvidos (tolerando
// 409) e grava o vinculo themembers product_id -> access group para a fase de
// matricula dos alunos.

import type { AccessGroupStore } from "./consumo-execute";
import type { GroupsRunPlan, PlannedGroup } from "./groups-plan";
import type { ProductGroupStore } from "./ledger";
import { TetraApiError, type CreatedAccessGroup } from "./tetra-api";

export type GroupsEnrollmentsClient = {
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
};

export type GroupsExecutionClients = {
  enrollments: GroupsEnrollmentsClient;
  accessGroupStore?: AccessGroupStore;
  productGroupStore?: ProductGroupStore;
};

export type GroupExecuteResult = {
  groupKey: string;
  finalName: string;
  status: "succeeded" | "partial" | "failed" | "skipped";
  accessGroupId?: string;
  created: boolean;
  reusedFromLedger: boolean;
  productsAttached: number;
  productsExisting: number;
  productsFailed: Array<{ productId: string; title: string; errorCode: string }>;
  skippedCourses: number;
  errorCode?: string;
};

export type GroupsExecuteReport = {
  runId: string;
  executedAt: string;
  adapter: "fake" | "tetra-dev";
  layout: "themembers-groups";
  tenantId: string;
  environment: GroupsRunPlan["environment"];
  summary: {
    plannedGroups: number;
    executedGroups: number;
    createdGroups: number;
    reusedGroups: number;
    failedGroups: number;
    skippedGroups: number;
    productsAttached: number;
    productsExisting: number;
    productsFailed: number;
    productLinksRecorded: number;
  };
  results: GroupExecuteResult[];
};

export function executeGroupsFake(plan: GroupsRunPlan, now = new Date()): GroupsExecuteReport {
  const results: GroupExecuteResult[] = plan.groups.map((group, index) => {
    if (group.status !== "ok") {
      return skippedResult(group, "AMBIGUOUS_PERIODICITY");
    }
    const resolved = group.courses.filter((course) => course.resolution === "resolved");
    return {
      groupKey: group.groupKey,
      finalName: group.finalName,
      status: "succeeded",
      accessGroupId: `fake-group-${index + 1}`,
      created: true,
      reusedFromLedger: false,
      productsAttached: resolved.length,
      productsExisting: 0,
      productsFailed: [],
      skippedCourses: group.courses.length - resolved.length,
    };
  });

  return buildReport(plan, "fake", now, results);
}

export async function executeGroupsRun(
  plan: GroupsRunPlan,
  clients: GroupsExecutionClients,
  now = new Date(),
): Promise<GroupsExecuteReport> {
  const results: GroupExecuteResult[] = [];

  for (const group of plan.groups) {
    if (group.status !== "ok") {
      results.push(skippedResult(group, "AMBIGUOUS_PERIODICITY"));
      continue;
    }
    results.push(await executeGroup(plan, group, clients));
  }

  return buildReport(plan, "tetra-dev", now, results);
}

async function executeGroup(
  plan: GroupsRunPlan,
  group: PlannedGroup,
  clients: GroupsExecutionClients,
): Promise<GroupExecuteResult> {
  let ensured: { id: string; created: boolean; reusedFromLedger: boolean };
  try {
    ensured = await ensureGroup(plan.tenantId, group, clients);
  } catch (error) {
    return {
      groupKey: group.groupKey,
      finalName: group.finalName,
      status: "failed",
      created: false,
      reusedFromLedger: false,
      productsAttached: 0,
      productsExisting: 0,
      productsFailed: [],
      skippedCourses: group.courses.length,
      errorCode: `GROUP_CREATE_FAILED:${describeError(error)}`,
    };
  }

  const resolved = group.courses.filter((course) => course.resolution === "resolved");
  const attachment = await attachCourses(ensured.id, resolved, clients);

  for (const source of group.sourceProducts) {
    clients.productGroupStore?.recordProductGroupLink(plan.tenantId, {
      themembersProductId: source.productId,
      themembersProductName: source.rawName,
      accessGroupId: ensured.id,
      groupName: group.finalName,
    });
  }

  return {
    groupKey: group.groupKey,
    finalName: group.finalName,
    status: attachment.failed.length === 0 ? "succeeded" : "partial",
    accessGroupId: ensured.id,
    created: ensured.created,
    reusedFromLedger: ensured.reusedFromLedger,
    productsAttached: attachment.attached,
    productsExisting: attachment.existing,
    productsFailed: attachment.failed,
    skippedCourses: group.courses.length - resolved.length,
  };
}

async function ensureGroup(
  tenantId: string,
  group: PlannedGroup,
  clients: GroupsExecutionClients,
): Promise<{ id: string; created: boolean; reusedFromLedger: boolean }> {
  const reusedId = clients.accessGroupStore?.findCreatedAccessGroup(tenantId, group.finalName);
  if (reusedId) {
    const existing = await clients.enrollments.getAccessGroup(reusedId);
    if (existing) {
      return { id: reusedId, created: false, reusedFromLedger: true };
    }
  }

  const created = await clients.enrollments.createAccessGroup({
    name: group.finalName,
    ...(group.periodicity && group.periodicityValue
      ? { periodicity: group.periodicity, periodicityValue: group.periodicityValue }
      : {}),
  });
  clients.accessGroupStore?.recordCreatedAccessGroup(tenantId, group.finalName, created.id);
  return { id: created.id, created: true, reusedFromLedger: false };
}

async function attachCourses(
  accessGroupId: string,
  courses: PlannedGroup["courses"],
  clients: GroupsExecutionClients,
): Promise<{
  attached: number;
  existing: number;
  failed: GroupExecuteResult["productsFailed"];
}> {
  const alreadyAttached = new Set(
    (await clients.enrollments.listAccessGroupProducts(accessGroupId))
      .map(extractProductId)
      .filter((id): id is string => Boolean(id)),
  );

  let attached = 0;
  let existing = 0;
  const failed: GroupExecuteResult["productsFailed"] = [];

  for (const course of courses) {
    if (!course.productId) continue;
    if (alreadyAttached.has(course.productId)) {
      existing += 1;
      continue;
    }

    try {
      await clients.enrollments.addAccessGroupProduct({
        accessGroupId,
        productId: course.productId,
        productType: "COURSE",
      });
      attached += 1;
    } catch (error) {
      if (isConflictError(error)) {
        existing += 1;
        continue;
      }
      failed.push({
        productId: course.productId,
        title: course.title,
        errorCode: describeError(error),
      });
    }
  }

  return { attached, existing, failed };
}

function skippedResult(group: PlannedGroup, errorCode: string): GroupExecuteResult {
  return {
    groupKey: group.groupKey,
    finalName: group.finalName,
    status: "skipped",
    created: false,
    reusedFromLedger: false,
    productsAttached: 0,
    productsExisting: 0,
    productsFailed: [],
    skippedCourses: group.courses.length,
    errorCode,
  };
}

function buildReport(
  plan: GroupsRunPlan,
  adapter: GroupsExecuteReport["adapter"],
  now: Date,
  results: GroupExecuteResult[],
): GroupsExecuteReport {
  const linkedProducts = plan.groups
    .filter((group) =>
      results.some(
        (result) =>
          result.groupKey === group.groupKey &&
          (result.status === "succeeded" || result.status === "partial"),
      ),
    )
    .reduce((total, group) => total + group.sourceProducts.length, 0);

  return {
    runId: plan.runId,
    executedAt: now.toISOString(),
    adapter,
    layout: plan.layout,
    tenantId: plan.tenantId,
    environment: plan.environment,
    summary: {
      plannedGroups: plan.groups.length,
      executedGroups: results.filter(
        (result) => result.status === "succeeded" || result.status === "partial",
      ).length,
      createdGroups: results.filter((result) => result.created).length,
      reusedGroups: results.filter((result) => result.reusedFromLedger).length,
      failedGroups: results.filter((result) => result.status === "failed").length,
      skippedGroups: results.filter((result) => result.status === "skipped").length,
      productsAttached: results.reduce((total, result) => total + result.productsAttached, 0),
      productsExisting: results.reduce((total, result) => total + result.productsExisting, 0),
      productsFailed: results.reduce((total, result) => total + result.productsFailed.length, 0),
      productLinksRecorded: adapter === "fake" ? 0 : linkedProducts,
    },
    results,
  };
}

function extractProductId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const value = record.productId ?? record.product_id ?? record.id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isConflictError(error: unknown): boolean {
  return error instanceof TetraApiError && error.status === 409;
}

function describeError(error: unknown): string {
  if (error instanceof TetraApiError) {
    return `${error.code}${error.status ? `_${error.status}` : ""}`;
  }
  return error instanceof Error ? error.message : "unknown error";
}
