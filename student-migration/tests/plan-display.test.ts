import { describe, expect, test } from "bun:test";
import { formatRunPlanForTui } from "../src/plan-display";
import { buildRunPlan, type MappingProfile, type SourceRow } from "../src/migration-plan";

describe("formatRunPlanForTui", () => {
  test("renders a redacted inline plan with operations, blockers, duplicates, and progress evidence", () => {
    const profile: MappingProfile = {
      version: 1,
      name: "fixture",
      tenantId: "tenant_dev",
      environment: "dev",
      fields: {
        email: "email",
        name: "name",
        phone: "phone",
        accessGroup: "group",
        product: "product",
        progressPercent: "progress",
        completed: "completed",
        accessedAt: "accessedAt",
      },
      mappings: {
        accessGroups: {
          "turma alpha": { id: "ag_alpha", name: "Turma Alpha" },
        },
        products: {
          "curso alpha": {
            id: "product_alpha",
            name: "Curso Alpha",
            type: "COURSE",
            courseId: "course_alpha",
          },
        },
      },
    };
    const rows: SourceRow[] = [
      {
        sheetName: "Membros",
        rowNumber: 2,
        values: {
          email: "membro.um@example.test",
          name: "Membro Um",
          phone: "+55 71 99999-9999",
          group: "Turma Alpha",
          product: "Curso Alpha",
          progress: "75",
          completed: "sim",
          accessedAt: "2026-01-10",
        },
      },
      {
        sheetName: "Membros",
        rowNumber: 3,
        values: {
          email: "membro.um@example.test",
          name: "Membro Um",
          group: "Turma Alpha",
          product: "Curso Alpha",
        },
      },
      {
        sheetName: "Membros",
        rowNumber: 4,
        values: {
          email: "sem.grupo@example.test",
          name: "Sem Grupo",
          group: "Turma Inexistente",
          product: "Curso Alpha",
        },
      },
    ];

    const plan = buildRunPlan(rows, profile, new Date("2026-06-10T12:00:00.000Z"), "run_test");
    const text = formatRunPlanForTui(plan);

    expect(text).toContain("Plano redigido");
    expect(text).toContain("tenant_dev");
    expect(text).toContain("Ambiente: dev");
    expect(text).toContain("Linhas validadas: 3");
    expect(text).toContain("Operacoes validas: 1");
    expect(text).toContain("Bloqueadas: 1");
    expect(text).toContain("Duplicadas agrupadas: 1");
    expect(text).toContain("Turma Alpha (ag_alpha)");
    expect(text).toContain("Curso Alpha (product_alpha, COURSE, course course_alpha)");
    expect(text).toContain("Progresso informado: sim");
    expect(text).toContain("Conclusao informada: sim");
    expect(text).toContain("Acesso historico informado: sim");
    expect(text).toContain("Escrita de progresso: nao planejada");
    expect(text).toContain("Linha bloqueada");
    expect(text).toContain("access group is missing or not mapped");
    expect(text).toContain("Membros:2");
    expect(text).toContain("Membros:3");
    expect(text).toContain("Membros:4");
    expect(text).toContain("hash:");

    expect(text).not.toContain("membro.um@example.test");
    expect(text).not.toContain("sem.grupo@example.test");
    expect(text).not.toContain("Membro Um");
    expect(text).not.toContain("+55 71 99999-9999");
  });
});
