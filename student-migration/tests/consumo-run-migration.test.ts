import { describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import type { ConsumoExecutionClients } from "../src/consumo-execute";
import { isConsumoPlan, runMigration } from "../src/run-migration";

const STORAGE_PREFIX = "./storage/test-consumo-run";

function makeFakeClients(calls: string[]): ConsumoExecutionClients {
  const created = new Map<string, string>();
  return {
    iam: {
      findOrCreateMembers: async (input) => {
        calls.push(`iam:${input.members.length}`);
        return input.members.map((member) => ({
          email: member.email,
          userId: `user-${member.email.split("@")[0]}`,
          created: true,
        }));
      },
    },
    enrollments: {
      getAccessGroup: async (id) => ({ id }),
      createAccessGroup: async (input) => {
        calls.push(`create-group:${input.name}`);
        return { id: "ag-smoke", name: input.name };
      },
      listAccessGroupProducts: async () => [],
      addAccessGroupProduct: async (input) => {
        calls.push(`add-product:${input.productId}`);
        return {};
      },
      addAccessGroupMember: async (input) => {
        calls.push(`add-member:${input.userId}`);
        return {};
      },
      findExistingEnrollment: async () => null,
      createManualEnrollment: async (input) => {
        calls.push(`enroll:${input.userId}:${input.productId}`);
        return {};
      },
      markLessonCompletedInternal: async (input) => {
        calls.push(`progress:${input.userId}:${input.lessonId}:${input.occurredAt}`);
        return { alreadyCompleted: false };
      },
    },
    accessGroupStore: {
      findCreatedAccessGroup: (tenantId, name) => created.get(`${tenantId}:${name}`),
      recordCreatedAccessGroup: (tenantId, name, id) => {
        created.set(`${tenantId}:${name}`, id);
      },
    },
  };
}

describe("runMigration com perfil v2 (themembers-consumo)", () => {
  test("dry-run + execute dev via arquivos reais de fixture", async () => {
    await rm(`${STORAGE_PREFIX}-runs.sqlite`, { force: true });
    const calls: string[] = [];

    const result = await runMigration({
      input: "./fixtures/themembers-consumo.csv",
      profile: "./examples/profile.themembers.local-smoke.json",
      output: `${STORAGE_PREFIX}-plan.json`,
      ledger: `${STORAGE_PREFIX}-runs.sqlite`,
      executeReport: `${STORAGE_PREFIX}-execute.json`,
      execute: true,
      adapter: "tetra-dev",
      allowDevExecute: true,
      consumoClients: makeFakeClients(calls),
    });

    expect(isConsumoPlan(result.plan)).toBe(true);
    if (!isConsumoPlan(result.plan)) return;

    expect(result.plan.source.memberOperations).toBe(2);
    expect(result.plan.source.plannedEnrollments).toBe(2);
    expect(result.plan.source.plannedProgressWrites).toBe(2);
    expect(result.plan.source.blockedRows).toBe(0);
    expect(result.plan.enrollmentWindow.accessEndsAt).toBe("2027-01-15T03:00:00.000Z");

    expect(result.executeSummary?.attemptedOperations).toBe(2);
    expect(result.executeSummary?.succeededOperations).toBe(2);
    expect(calls).toContain("create-group:Migracao Smoke Anual");
    expect(calls).toContain("add-product:prod_smoke_excel");
    expect(calls.filter((call) => call.startsWith("enroll:"))).toHaveLength(2);
    expect(calls).toContain("progress:user-ada:lesson_smoke_1:2026-05-05T03:00:00.000Z");
    expect(calls).toContain("progress:user-grace:lesson_smoke_1:2026-06-01T03:00:00.000Z");

    const planJson = await readFile(`${STORAGE_PREFIX}-plan.json`, "utf8");
    expect(planJson).not.toContain("ada@example.com");
    expect(planJson).not.toContain("Ada Lovelace");
    expect(planJson).not.toContain("5511999990001");

    const reportJson = await readFile(`${STORAGE_PREFIX}-execute.json`, "utf8");
    expect(reportJson).not.toContain("ada@example.com");
  });

  test("producao: execute exige approval file com runId correspondente", async () => {
    const calls: string[] = [];
    const profile = JSON.parse(
      await readFile("./examples/profile.themembers.local-smoke.json", "utf8"),
    );
    profile.environment = "production";
    profile.catalogMapPath = "../examples/catalog-map.local-smoke.json";
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(`${STORAGE_PREFIX}-prod-profile.json`, JSON.stringify(profile));

    // sem approval -> prepare com execute deve falhar
    await expect(
      runMigration({
        input: "./fixtures/themembers-consumo.csv",
        profile: `${STORAGE_PREFIX}-prod-profile.json`,
        output: `${STORAGE_PREFIX}-prod-plan.json`,
        ledger: `${STORAGE_PREFIX}-prod-runs.sqlite`,
        executeReport: `${STORAGE_PREFIX}-prod-execute.json`,
        execute: true,
        adapter: "tetra-dev",
        allowDevExecute: true,
        consumoClients: makeFakeClients(calls),
      }),
    ).rejects.toThrow("approval file");
    expect(calls.filter((c) => !c.startsWith("iam:"))).toHaveLength(0);
  });

  test("override de janela digitado na TUI recalcula accessEndsAt", async () => {
    const result = await runMigration({
      input: "./fixtures/themembers-consumo.csv",
      profile: "./examples/profile.themembers.local-smoke.json",
      output: `${STORAGE_PREFIX}-override-plan.json`,
      ledger: `${STORAGE_PREFIX}-override-runs.sqlite`,
      executeReport: `${STORAGE_PREFIX}-override-execute.json`,
      execute: false,
      consumoOverrides: {
        accessStartsAt: "2026-03-01",
        periodicity: "MONTHLY",
        periodicityValue: 6,
      },
    });

    if (!isConsumoPlan(result.plan)) throw new Error("expected consumo plan");
    expect(result.plan.enrollmentWindow.accessStartsAt).toBe("2026-03-01T03:00:00.000Z");
    expect(result.plan.enrollmentWindow.accessEndsAt).toBe("2026-09-01T03:00:00.000Z");
    expect(result.plan.enrollmentWindow.periodicity).toBe("MONTHLY");
  });
});
