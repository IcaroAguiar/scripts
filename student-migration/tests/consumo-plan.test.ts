import { describe, expect, test } from "bun:test";
import type { CatalogMap } from "../src/catalog-map";
import { buildTitleIndex, resolveCourseByTitle, resolveLessonByTitle } from "../src/catalog-map";
import {
  buildConsumoPreparedRun,
  CONSUMO_BLOCK_REASONS,
  type MappingProfileV2,
} from "../src/consumo-plan";
import { detectConsumoLayout, parseConsumoRows } from "../src/layouts/themembers-consumo";
import { csvRowsToSourceRows } from "../src/migration-plan";
import { computeAccessEndsAt, describeRemaining, parseSaoPauloDate } from "../src/period";

const catalogMap: CatalogMap = {
  tenantId: "tenant_local_tetra",
  generatedAt: "2026-07-01T00:00:00.000Z",
  products: [
    {
      productId: "prod-excel",
      productTitle: "Excel Esencial",
      courseId: "course-excel",
      lessons: [
        {
          lessonId: "lesson-1",
          lessonTitle: "Clase 1 - Introduccion",
          moduleTitle: "Introducción",
          order: 1,
        },
        {
          lessonId: "lesson-2",
          lessonTitle: "Clase 2 - Formulas",
          moduleTitle: "Introducción",
          order: 2,
        },
        {
          lessonId: "lesson-dup-a",
          lessonTitle: "Repaso",
          moduleTitle: "Modulo A",
          order: 3,
        },
        {
          lessonId: "lesson-dup-b",
          lessonTitle: "Repaso",
          moduleTitle: "Modulo B",
          order: 4,
        },
      ],
    },
    {
      productId: "prod-powerbi",
      productTitle: "Power BI Esencial",
      courseId: "course-powerbi",
      lessons: [
        {
          lessonId: "lesson-pb-1",
          lessonTitle: "Clase 1 - Dashboards",
          moduleTitle: null,
          order: 1,
        },
      ],
    },
  ],
};

const profile: MappingProfileV2 = {
  version: 2,
  layout: "themembers-consumo",
  name: "Perfil de teste consumo",
  tenantId: "tenant_local_tetra",
  environment: "local",
  accessGroup: {
    mode: "create",
    name: "Grupo Anual 2026",
    periodicity: "YEARLY",
    periodicityValue: 1,
  },
  enrollmentWindow: {
    accessStartsAt: "2026-01-15",
    periodicity: "YEARLY",
    periodicityValue: 1,
  },
  catalogMapPath: "storage/catalog-map.test.json",
};

function makeRows(values: Record<string, string>[]) {
  return csvRowsToSourceRows(values);
}

const baseRow = {
  student_email: "ada@example.com",
  student_name: "Ada Lovelace",
  student_phone: "5511999999999",
  course_title: "Excel Esencial",
  module_title: "Introducción",
  lesson_title: "Clase 1 - Introduccion",
  finished: "1",
  finished_at: "2026-05-05",
};

describe("period", () => {
  test("computeAccessEndsAt YEARLY soma 1 ano em America/Sao_Paulo", () => {
    const window = computeAccessEndsAt("2026-01-15", "YEARLY", 1);
    expect(window.accessStartsAtIso).toBe("2026-01-15T03:00:00.000Z");
    expect(window.accessEndsAtIso).toBe("2027-01-15T03:00:00.000Z");
  });

  test("computeAccessEndsAt MONTHLY clampa fim de mes", () => {
    const window = computeAccessEndsAt("2026-01-31", "MONTHLY", 1);
    expect(window.accessEndsAtIso).toBe("2026-02-28T03:00:00.000Z");
  });

  test("computeAccessEndsAt DAILY soma dias", () => {
    const window = computeAccessEndsAt("2026-12-30", "DAILY", 5);
    expect(window.accessEndsAtIso).toBe("2027-01-04T03:00:00.000Z");
  });

  test("parseSaoPauloDate trata data pura como -03:00", () => {
    expect(parseSaoPauloDate("2026-05-05")?.toISOString()).toBe("2026-05-05T03:00:00.000Z");
    expect(parseSaoPauloDate("2026-05-05T16:34:27-03:00")?.toISOString()).toBe(
      "2026-05-05T19:34:27.000Z",
    );
    expect(parseSaoPauloDate("nao-e-data")).toBeUndefined();
  });

  test("describeRemaining marca janela expirada", () => {
    const now = new Date("2026-07-01T00:00:00Z");
    expect(describeRemaining(now, "2026-06-01T00:00:00Z").expired).toBe(true);
    expect(describeRemaining(now, "2026-07-31T00:00:00Z")).toEqual({
      expired: false,
      remainingDays: 30,
    });
  });
});

describe("themembers-consumo layout", () => {
  test("detecta layout pelos cabecalhos", () => {
    expect(detectConsumoLayout(Object.keys(baseRow))).toBe(true);
    expect(detectConsumoLayout(["Aluno", "E-mail"])).toBe(false);
  });

  test("parse valida finished e finished_at", () => {
    const rows = parseConsumoRows(
      makeRows([
        baseRow,
        { ...baseRow, finished: "2" },
        { ...baseRow, finished: "1", finished_at: "" },
        { ...baseRow, student_email: "sem-arroba" },
      ]),
    );

    expect(rows[0]?.issues).toEqual([]);
    expect(rows[0]?.finishedAtIso).toBe("2026-05-05T03:00:00.000Z");
    expect(rows[1]?.issues).toContain('finished must be 0 or 1, got "2"');
    expect(rows[2]?.issues).toContain("finished=1 requires a valid finished_at date");
    expect(rows[3]?.issues).toContain("email is invalid");
  });
});

describe("catalog title index", () => {
  const index = buildTitleIndex(catalogMap);

  test("resolve curso por titulo normalizado", () => {
    const resolution = resolveCourseByTitle(index, "  excel esencial ");
    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") {
      expect(resolution.target.courseId).toBe("course-excel");
    }
    expect(resolveCourseByTitle(index, "Curso Inexistente").status).toBe("unresolved");
  });

  test("resolve aula por curso+modulo+titulo e detecta ambiguidade no fallback", () => {
    const exact = resolveLessonByTitle(index, "Excel Esencial", "Introducción", "Clase 1 - Introduccion");
    expect(exact).toEqual({ status: "resolved", lessonId: "lesson-1" });

    const byModule = resolveLessonByTitle(index, "Excel Esencial", "Modulo A", "Repaso");
    expect(byModule).toEqual({ status: "resolved", lessonId: "lesson-dup-a" });

    // Sem modulo, "Repaso" existe em dois modulos -> ambigua.
    const ambiguous = resolveLessonByTitle(index, "Excel Esencial", "", "Repaso");
    expect(ambiguous.status).toBe("ambiguous");

    const missing = resolveLessonByTitle(index, "Excel Esencial", "Introducción", "Aula Fantasma");
    expect(missing.status).toBe("unresolved");
  });

  test("aula de modulo null resolve com modulo vazio", () => {
    const resolution = resolveLessonByTitle(index, "Power BI Esencial", "", "Clase 1 - Dashboards");
    expect(resolution).toEqual({ status: "resolved", lessonId: "lesson-pb-1" });
  });
});

describe("buildConsumoPreparedRun", () => {
  test("agrega linhas por membro com matriculas por curso e progressos", () => {
    const prepared = buildConsumoPreparedRun(
      makeRows([
        baseRow,
        {
          ...baseRow,
          lesson_title: "Clase 2 - Formulas",
          finished: "0",
          finished_at: "",
        },
        {
          ...baseRow,
          course_title: "Power BI Esencial",
          module_title: "",
          lesson_title: "Clase 1 - Dashboards",
          finished: "1",
          finished_at: "2026-06-01",
        },
        {
          ...baseRow,
          student_email: "grace@example.com",
          student_name: "Grace Hopper",
        },
      ]),
      profile,
      catalogMap,
      new Date("2026-07-01T00:00:00Z"),
      "run-test-1",
    );

    const { plan, privateContext } = prepared;
    expect(plan.source.memberOperations).toBe(2);
    expect(plan.source.plannedEnrollments).toBe(3);
    expect(plan.source.plannedProgressWrites).toBe(3);
    expect(plan.source.blockedRows).toBe(0);
    expect(plan.enrollmentWindow.accessEndsAt).toBe("2027-01-15T03:00:00.000Z");

    const ada = privateContext.members.find((member) => member.email === "ada@example.com");
    expect(ada?.name).toBe("Ada Lovelace");
    const adaOperation = plan.operations.find(
      (operation) => operation.operationId === ada?.operationId,
    );
    expect(adaOperation?.enrollments.map((enrollment) => enrollment.courseId).sort()).toEqual([
      "course-excel",
      "course-powerbi",
    ]);
    expect(adaOperation?.progressWrites).toHaveLength(2);
    expect(adaOperation?.progressWrites[0]?.occurredAt).toBe("2026-05-05T03:00:00.000Z");

    // Plano redigido: nenhum email/nome no JSON do plano.
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("Ada Lovelace");
    expect(serialized).not.toContain("5511999999999");
  });

  test("curso nao resolvido bloqueia a linha; aula nao resolvida bloqueia so o progresso", () => {
    const prepared = buildConsumoPreparedRun(
      makeRows([
        { ...baseRow, course_title: "Curso Fantasma" },
        { ...baseRow, lesson_title: "Aula Fantasma" },
      ]),
      profile,
      catalogMap,
      new Date("2026-07-01T00:00:00Z"),
      "run-test-2",
    );

    const { plan } = prepared;
    expect(plan.source.blockedRows).toBe(1);
    expect(plan.source.progressOnlyBlockedRows).toBe(1);
    expect(plan.blockedReasonCounts[CONSUMO_BLOCK_REASONS.COURSE_UNRESOLVED]).toBe(1);
    expect(plan.blockedReasonCounts[CONSUMO_BLOCK_REASONS.LESSON_UNRESOLVED]).toBe(1);

    // A matricula do curso resolvido continua planejada mesmo com a aula bloqueada.
    expect(plan.source.memberOperations).toBe(1);
    expect(plan.source.plannedEnrollments).toBe(1);
    expect(plan.source.plannedProgressWrites).toBe(0);
    expect(plan.catalog.unresolvedCourseTitles).toEqual(["Curso Fantasma"]);
    expect(plan.catalog.unresolvedLessonTitles).toEqual([
      "Excel Esencial / Introducción / Aula Fantasma",
    ]);
  });

  test("rerun do mesmo input gera operacoes deterministicas", () => {
    const rows = makeRows([baseRow]);
    const first = buildConsumoPreparedRun(rows, profile, catalogMap, new Date(0), "run-a");
    const second = buildConsumoPreparedRun(rows, profile, catalogMap, new Date(0), "run-b");

    expect(first.plan.operations[0]?.operationId).toBe(second.plan.operations[0]?.operationId);
    expect(first.plan.operations[0]?.idempotencyKey).toBe(
      second.plan.operations[0]?.idempotencyKey,
    );
  });
});
