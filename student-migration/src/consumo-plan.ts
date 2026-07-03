import { randomUUID } from "node:crypto";
import {
  buildTitleIndex,
  type CatalogMap,
  resolveCourseByTitle,
  resolveLessonByTitle,
  type TitleIndex,
} from "./catalog-map";
import { type ConsumoRow, parseConsumoRows } from "./layouts/themembers-consumo";
import type { MappingProfile, SourceRef, SourceRow } from "./migration-plan";
import { hashValue } from "./migration-plan";
import { type AccessGroupPeriodicity, computeAccessEndsAt } from "./period";

export type AccessGroupChoice =
  | { mode: "existing"; id: string; name?: string }
  | {
      mode: "create";
      name: string;
      periodicity: AccessGroupPeriodicity;
      periodicityValue: number;
    };

export type MappingProfileV2 = {
  version: 2;
  layout: "themembers-consumo";
  name: string;
  tenantId: string;
  environment: MappingProfile["environment"];
  accessGroup: AccessGroupChoice;
  enrollmentWindow: {
    /** Data local (YYYY-MM-DD, America/Sao_Paulo) do inicio da matricula. */
    accessStartsAt: string;
    periodicity: AccessGroupPeriodicity;
    periodicityValue: number;
  };
  /** Caminho local (gitignorado) do course-map sincronizado do tetra-products. */
  catalogMapPath: string;
};

export type AnyMappingProfile = MappingProfile | MappingProfileV2;

export function isProfileV2(profile: AnyMappingProfile): profile is MappingProfileV2 {
  return profile.version === 2;
}

export type PlannedEnrollment = {
  productId: string;
  courseId: string;
  courseTitle: string;
  accessStartsAt: string;
  accessEndsAt: string;
};

export type PlannedProgressWrite = {
  lessonId: string;
  courseId: string;
  productId: string;
  occurredAt: string;
  sourceRef: SourceRef;
};

export type PlannedMemberOperation = {
  operationId: string;
  member: {
    memberHash: string;
    hasName: boolean;
    hasPhoneEvidence: boolean;
  };
  enrollments: PlannedEnrollment[];
  progressWrites: PlannedProgressWrite[];
  sourceRefCount: number;
  idempotencyKey: string;
  action: "ensure_member_group_enrollments_progress";
};

export type ConsumoBlockedRow = {
  sourceRef: SourceRef;
  memberHash?: string;
  reasons: string[];
  scope: "row" | "progress-only";
};

export type ConsumoRunPlan = {
  runId: string;
  generatedAt: string;
  dryRun: true;
  layout: "themembers-consumo";
  tenantId: string;
  environment: MappingProfile["environment"];
  accessGroup: AccessGroupChoice;
  enrollmentWindow: {
    accessStartsAt: string;
    accessEndsAt: string;
    periodicity: AccessGroupPeriodicity;
    periodicityValue: number;
  };
  source: {
    totalRows: number;
    memberOperations: number;
    plannedEnrollments: number;
    plannedProgressWrites: number;
    blockedRows: number;
    progressOnlyBlockedRows: number;
  };
  blockedReasonCounts: Record<string, number>;
  catalog: {
    ambiguousCourseTitles: string[];
    unresolvedCourseTitles: string[];
    unresolvedLessonTitles: string[];
  };
  operations: PlannedMemberOperation[];
  blockedRows: ConsumoBlockedRow[];
};

export type ConsumoPrivateContext = {
  runId: string;
  tenantId: string;
  environment: MappingProfile["environment"];
  members: Array<{
    operationId: string;
    email: string;
    name?: string;
  }>;
};

export type ConsumoPreparedRun = {
  plan: ConsumoRunPlan;
  privateContext: ConsumoPrivateContext;
};

export const CONSUMO_BLOCK_REASONS = {
  EMAIL_REQUIRED: "email is required",
  EMAIL_INVALID: "email is invalid",
  COURSE_UNRESOLVED: "course title not found in catalog map",
  COURSE_AMBIGUOUS: "course title is ambiguous in catalog map",
  LESSON_UNRESOLVED: "lesson title not found in catalog map",
  LESSON_AMBIGUOUS: "lesson title is ambiguous in catalog map",
  FINISHED_AT_MISSING: "finished=1 requires a valid finished_at date",
} as const;

export function buildConsumoPreparedRun(
  rows: SourceRow[],
  profile: MappingProfileV2,
  catalogMap: CatalogMap,
  now = new Date(),
  runId: string = randomUUID(),
): ConsumoPreparedRun {
  const index = buildTitleIndex(catalogMap);
  const consumoRows = parseConsumoRows(rows);
  const window = computeAccessEndsAt(
    profile.enrollmentWindow.accessStartsAt,
    profile.enrollmentWindow.periodicity,
    profile.enrollmentWindow.periodicityValue,
  );

  const membersByHash = new Map<string, MemberAccumulator>();
  const blockedRows: ConsumoBlockedRow[] = [];
  const unresolvedCourseTitles = new Set<string>();
  const unresolvedLessonTitles = new Set<string>();

  for (const row of consumoRows) {
    const rowBlockReasons = collectRowBlockReasons(row);
    const memberHash = row.email ? hashValue(row.email) : undefined;

    if (rowBlockReasons.length > 0) {
      blockedRows.push({
        sourceRef: row.sourceRef,
        ...(memberHash ? { memberHash } : {}),
        reasons: rowBlockReasons,
        scope: "row",
      });
      continue;
    }

    const courseResolution = resolveCourseByTitle(index, row.courseTitle);
    if (courseResolution.status !== "resolved") {
      unresolvedCourseTitles.add(row.courseTitle);
      blockedRows.push({
        sourceRef: row.sourceRef,
        ...(memberHash ? { memberHash } : {}),
        reasons: [
          courseResolution.status === "ambiguous"
            ? CONSUMO_BLOCK_REASONS.COURSE_AMBIGUOUS
            : CONSUMO_BLOCK_REASONS.COURSE_UNRESOLVED,
        ],
        scope: "row",
      });
      continue;
    }

    if (!memberHash) {
      throw new Error("internal consumo planning invariant violated");
    }

    const accumulator = getOrCreateMember(membersByHash, memberHash, row);
    accumulator.enrollments.set(courseResolution.target.courseId, {
      productId: courseResolution.target.productId,
      courseId: courseResolution.target.courseId,
      courseTitle: courseResolution.target.productTitle,
      accessStartsAt: window.accessStartsAtIso,
      accessEndsAt: window.accessEndsAtIso,
    });
    accumulator.sourceRefCount += 1;

    if (!row.finished) {
      continue;
    }

    // Linhas finished=1 sem data ja foram bloqueadas na validacao do layout.
    const lessonResolution = resolveLessonByTitle(
      index,
      row.courseTitle,
      row.moduleTitle,
      row.lessonTitle,
    );
    if (lessonResolution.status !== "resolved") {
      unresolvedLessonTitles.add(`${row.courseTitle} / ${row.moduleTitle} / ${row.lessonTitle}`);
      blockedRows.push({
        sourceRef: row.sourceRef,
        memberHash,
        reasons: [
          lessonResolution.status === "ambiguous"
            ? CONSUMO_BLOCK_REASONS.LESSON_AMBIGUOUS
            : CONSUMO_BLOCK_REASONS.LESSON_UNRESOLVED,
        ],
        scope: "progress-only",
      });
      continue;
    }

    if (!row.finishedAtIso) {
      throw new Error("internal consumo planning invariant violated: finishedAtIso");
    }

    accumulator.progressWrites.push({
      lessonId: lessonResolution.lessonId,
      courseId: courseResolution.target.courseId,
      productId: courseResolution.target.productId,
      occurredAt: row.finishedAtIso,
      sourceRef: row.sourceRef,
    });
  }

  const operations: PlannedMemberOperation[] = [];
  const privateMembers: ConsumoPrivateContext["members"] = [];

  for (const [memberHash, accumulator] of membersByHash.entries()) {
    if (accumulator.enrollments.size === 0) {
      continue;
    }

    const operationId = hashValue(`member:${memberHash}`).slice(0, 20);
    operations.push({
      operationId,
      member: {
        memberHash,
        hasName: accumulator.name.length > 0,
        hasPhoneEvidence: accumulator.hasPhone,
      },
      enrollments: Array.from(accumulator.enrollments.values()).sort((a, b) =>
        a.courseTitle.localeCompare(b.courseTitle),
      ),
      progressWrites: accumulator.progressWrites,
      sourceRefCount: accumulator.sourceRefCount,
      idempotencyKey: `student-migration:${profile.tenantId}:${memberHash.slice(0, 24)}`,
      action: "ensure_member_group_enrollments_progress",
    });
    privateMembers.push({
      operationId,
      email: accumulator.email,
      ...(accumulator.name ? { name: accumulator.name } : {}),
    });
  }

  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  privateMembers.sort((a, b) => a.operationId.localeCompare(b.operationId));

  const blockedReasonCounts: Record<string, number> = {};
  for (const blocked of blockedRows) {
    for (const reason of blocked.reasons) {
      blockedReasonCounts[reason] = (blockedReasonCounts[reason] ?? 0) + 1;
    }
  }

  const plan: ConsumoRunPlan = {
    runId,
    generatedAt: now.toISOString(),
    dryRun: true,
    layout: "themembers-consumo",
    tenantId: profile.tenantId,
    environment: profile.environment,
    accessGroup: profile.accessGroup,
    enrollmentWindow: {
      accessStartsAt: window.accessStartsAtIso,
      accessEndsAt: window.accessEndsAtIso,
      periodicity: profile.enrollmentWindow.periodicity,
      periodicityValue: profile.enrollmentWindow.periodicityValue,
    },
    source: {
      totalRows: rows.length,
      memberOperations: operations.length,
      plannedEnrollments: operations.reduce((sum, op) => sum + op.enrollments.length, 0),
      plannedProgressWrites: operations.reduce((sum, op) => sum + op.progressWrites.length, 0),
      blockedRows: blockedRows.filter((row) => row.scope === "row").length,
      progressOnlyBlockedRows: blockedRows.filter((row) => row.scope === "progress-only").length,
    },
    blockedReasonCounts,
    catalog: {
      ambiguousCourseTitles: buildAmbiguousCourseReport(index),
      unresolvedCourseTitles: Array.from(unresolvedCourseTitles).sort(),
      unresolvedLessonTitles: Array.from(unresolvedLessonTitles).sort(),
    },
    operations,
    blockedRows,
  };

  return {
    plan,
    privateContext: {
      runId,
      tenantId: profile.tenantId,
      environment: profile.environment,
      members: privateMembers,
    },
  };
}

type MemberAccumulator = {
  email: string;
  name: string;
  hasPhone: boolean;
  sourceRefCount: number;
  enrollments: Map<string, PlannedEnrollment>;
  progressWrites: PlannedProgressWrite[];
};

function getOrCreateMember(
  members: Map<string, MemberAccumulator>,
  memberHash: string,
  row: ConsumoRow,
): MemberAccumulator {
  const existing = members.get(memberHash);
  if (existing) {
    if (!existing.name && row.name) existing.name = row.name;
    if (!existing.hasPhone && row.phone) existing.hasPhone = true;
    return existing;
  }

  const created: MemberAccumulator = {
    email: row.email,
    name: row.name,
    hasPhone: Boolean(row.phone),
    sourceRefCount: 0,
    enrollments: new Map(),
    progressWrites: [],
  };
  members.set(memberHash, created);
  return created;
}

function collectRowBlockReasons(row: ConsumoRow): string[] {
  return row.issues;
}

function buildAmbiguousCourseReport(index: TitleIndex): string[] {
  return index.ambiguousCourseTitles;
}
