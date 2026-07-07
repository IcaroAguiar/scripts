// Montagem do plano de grupos de migracao: agrega produtos TheMembers por
// nome normalizado, classifica no tipo de grupo, resolve os cursos do xlsx
// contra o catalog map e produz um plano revisavel antes de qualquer execute.

import { createHash } from "node:crypto";
import { buildTitleIndex, resolveCourseByTitle, type CatalogMap } from "./catalog-map";
import type { CourseListByType } from "./course-list";
import {
  canonicalTetraClubName,
  classifyProduct,
  describePeriodicity,
  groupKeyForName,
  normalizeGroupName,
  parsePeriodicityFromName,
  type GroupPeriodicity,
  type GroupType,
} from "./group-naming";
import type { ProductAggregate } from "./layouts/themembers-products";

export type GroupsEnvironment = "local" | "dev" | "production";

export type PlannedCourse = {
  title: string;
  resolution: "resolved" | "unresolved" | "ambiguous";
  productId?: string;
  courseId?: string;
};

export type PlannedGroup = {
  groupKey: string;
  type: GroupType;
  finalName: string;
  periodicity?: GroupPeriodicity["periodicity"];
  periodicityValue?: number;
  periodicityNote?: string;
  status: "ok" | "ambiguous-periodicity";
  totalStudents: number;
  sourceProducts: Array<{
    productId: string;
    rawName: string;
    studentCount: number;
  }>;
  courses: PlannedCourse[];
};

export type ReportedProduct = {
  productId: string;
  rawName: string;
  studentCount: number;
  reason?: string;
};

export type GroupsRunPlan = {
  runId: string;
  generatedAt: string;
  layout: "themembers-groups";
  tenantId: string;
  environment: GroupsEnvironment;
  summary: {
    products: number;
    inScopeProducts: number;
    groups: number;
    executableGroups: number;
    ambiguousProducts: number;
    excludedProducts: number;
    outOfScopeProducts: number;
    unresolvedCourses: number;
  };
  courseList: CourseListByType;
  groups: PlannedGroup[];
  ambiguousProducts: ReportedProduct[];
  excludedProducts: ReportedProduct[];
  outOfScopeProducts: ReportedProduct[];
};

// Fallback para grupos vitalicios/sem mencao: o dominio do enrollments nao
// tem "sem expiracao", entao acesso longo de 100 anos (decisao 2026-07-07).
const LIFETIME_FALLBACK: GroupPeriodicity = { periodicity: "YEARLY", periodicityValue: 100 };

export type BuildGroupsPlanInput = {
  tenantId: string;
  environment: GroupsEnvironment;
  products: ProductAggregate[];
  courseList: CourseListByType;
  catalogMap: CatalogMap;
  now?: Date;
};

export function buildGroupsPlan(input: BuildGroupsPlanInput): GroupsRunPlan {
  const now = input.now ?? new Date();
  const titleIndex = buildTitleIndex(input.catalogMap);

  const resolvedCoursesByType = {} as Record<GroupType, PlannedCourse[]>;
  for (const type of ["tetra-club", "pos", "mba"] as const) {
    resolvedCoursesByType[type] = input.courseList[type].courses.map((title) => {
      const resolution = resolveCourseByTitle(titleIndex, title);
      if (resolution.status === "resolved") {
        return {
          title,
          resolution: "resolved",
          productId: resolution.target.productId,
          courseId: resolution.target.courseId,
        };
      }
      return { title, resolution: resolution.status };
    });
  }

  const groupsByKey = new Map<string, PlannedGroup>();
  const ambiguousProducts: ReportedProduct[] = [];
  const excludedProducts: ReportedProduct[] = [];
  const outOfScopeProducts: ReportedProduct[] = [];

  for (const product of input.products) {
    const classification = classifyProduct(product.productName);

    if (classification.status === "out-of-scope") {
      outOfScopeProducts.push({
        productId: product.productId,
        rawName: product.productName,
        studentCount: product.studentCount,
      });
      continue;
    }

    if (classification.status === "excluded") {
      excludedProducts.push({
        productId: product.productId,
        rawName: product.productName,
        studentCount: product.studentCount,
        reason: classification.reason,
      });
      continue;
    }

    if (classification.status === "ambiguous") {
      ambiguousProducts.push({
        productId: product.productId,
        rawName: product.productName,
        studentCount: product.studentCount,
        reason: classification.reason,
      });
      continue;
    }

    // Deduplicacao canonica de "Tetra Club puro": variantes de formatacao
    // consolidam no mesmo nome/chave canonicos.
    const canonicalName =
      classification.type === "tetra-club"
        ? canonicalTetraClubName(product.productName)
        : undefined;
    const groupKey = canonicalName
      ? canonicalName.toLowerCase()
      : groupKeyForName(product.productName);
    const existing = groupsByKey.get(groupKey);
    if (existing) {
      existing.sourceProducts.push({
        productId: product.productId,
        rawName: product.productName,
        studentCount: product.studentCount,
      });
      existing.totalStudents += product.studentCount;
      continue;
    }

    const periodicity = parsePeriodicityFromName(product.productName);
    const group: PlannedGroup = {
      groupKey,
      type: classification.type,
      finalName: canonicalName ?? normalizeGroupName(product.productName),
      status: periodicity.status === "conflicting" ? "ambiguous-periodicity" : "ok",
      totalStudents: product.studentCount,
      sourceProducts: [
        {
          productId: product.productId,
          rawName: product.productName,
          studentCount: product.studentCount,
        },
      ],
      courses: resolvedCoursesByType[classification.type],
    };

    if (periodicity.status === "parsed") {
      group.periodicity = periodicity.value.periodicity;
      group.periodicityValue = periodicity.value.periodicityValue;
      group.periodicityNote = describePeriodicity(periodicity.value);
    } else if (periodicity.status === "lifetime") {
      // O enrollments exige periodicidade numerica; vitalicio vira acesso de
      // 100 anos (decisao 2026-07-07).
      group.periodicity = LIFETIME_FALLBACK.periodicity;
      group.periodicityValue = LIFETIME_FALLBACK.periodicityValue;
      group.periodicityNote = "vitalicio -> 100 anos (decisao 2026-07-07)";
    } else if (periodicity.status === "conflicting") {
      group.periodicityNote = periodicity.detail;
    } else {
      // Sem mencao no nome: mesmo fallback longo do vitalicio (decisao
      // 2026-07-07); ajustavel grupo a grupo no admin depois.
      group.periodicity = LIFETIME_FALLBACK.periodicity;
      group.periodicityValue = LIFETIME_FALLBACK.periodicityValue;
      group.periodicityNote = "sem mencao -> 100 anos (decisao 2026-07-07)";
    }

    groupsByKey.set(groupKey, group);
  }

  const groups = Array.from(groupsByKey.values()).sort(
    (a, b) => b.totalStudents - a.totalStudents,
  );
  const unresolvedCourses = new Set<string>();
  for (const type of ["tetra-club", "pos", "mba"] as const) {
    for (const course of resolvedCoursesByType[type]) {
      if (course.resolution !== "resolved") {
        unresolvedCourses.add(course.title);
      }
    }
  }

  const inScopeProducts = groups.reduce((total, group) => total + group.sourceProducts.length, 0);

  return {
    runId: buildRunId(input.tenantId, input.environment, groups),
    generatedAt: now.toISOString(),
    layout: "themembers-groups",
    tenantId: input.tenantId,
    environment: input.environment,
    summary: {
      products: input.products.length,
      inScopeProducts,
      groups: groups.length,
      executableGroups: groups.filter((group) => group.status === "ok").length,
      ambiguousProducts: ambiguousProducts.length,
      excludedProducts: excludedProducts.length,
      outOfScopeProducts: outOfScopeProducts.length,
      unresolvedCourses: unresolvedCourses.size,
    },
    courseList: input.courseList,
    groups,
    ambiguousProducts,
    excludedProducts,
    outOfScopeProducts,
  };
}

/**
 * runId deterministico pelo conteudo executavel do plano: o mesmo input gera
 * o mesmo runId em dry-run e execute, viabilizando o approval de producao
 * (que compara runId) e invalidando approvals quando o plano muda.
 */
function buildRunId(
  tenantId: string,
  environment: GroupsEnvironment,
  groups: PlannedGroup[],
): string {
  const material = [
    tenantId,
    environment,
    ...groups
      .map(
        (group) =>
          `${group.groupKey}|${group.finalName}|${group.periodicity ?? ""}|${group.periodicityValue ?? ""}|${group.status}|${group.courses
            .filter((course) => course.resolution === "resolved")
            .map((course) => course.productId)
            .sort()
            .join(",")}`,
      )
      .sort(),
  ].join("\n");

  const hash = createHash("sha256").update(material).digest("hex").slice(0, 12);
  return `groups_${hash}`;
}
