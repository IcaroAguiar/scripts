import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCsv } from "../src/csv";
import { EXECUTE_ADAPTERS, executeRun } from "../src/execute";
import { openMigrationLedger } from "../src/ledger";
import {
  assertExecutionAllowed,
  buildRunPlan,
  csvRowsToSourceRows,
  type ApprovalFile,
  type MappingProfile,
} from "../src/migration-plan";
import { readWorkbook } from "../src/workbook";

const profile: MappingProfile = {
  version: 1,
  name: "Fake profile",
  tenantId: "tenant_fake_001",
  environment: "dev",
  fields: {
    email: "E-mail",
    name: "Aluno",
    phone: "Telefone",
    accessGroup: "Grupo",
    product: "Curso",
    progressPercent: "Porcentagem da Aula",
    completed: "Concluida",
    accessedAt: "Data de Acesso",
  },
  mappings: {
    accessGroups: {
      "grupo fake": { id: "ag_fake_001", name: "Grupo Fake" },
    },
    products: {
      "curso fake": {
        id: "prod_fake_001",
        name: "Curso Fake",
        type: "COURSE",
        courseId: "course_fake_001",
      },
    },
  },
};

describe("parseCsv", () => {
  test("parses quoted commas and trims mapped values", () => {
    const rows = parseCsv('E-mail,Aluno,Grupo\nmembro@example.test,"Membro, Um", Grupo Fake\n');

    expect(rows).toEqual([
      {
        "E-mail": "membro@example.test",
        Aluno: "Membro, Um",
        Grupo: "Grupo Fake",
      },
    ]);
  });
});

describe("readWorkbook", () => {
  test("reads the synthetic CSV and XLSX fixtures with preserved row metadata", async () => {
    const csvRows = await readWorkbook("./fixtures/members-progress.csv");
    const xlsxRows = await readWorkbook("./fixtures/members-progress.xlsx");

    expect(csvRows).toHaveLength(4);
    expect(xlsxRows).toHaveLength(4);
    expect(csvRows[0]?.sheetName).toBe("csv");
    expect(xlsxRows[0]?.sheetName).toBe("Membros");
    expect(csvRows[0]?.rowNumber).toBe(2);
    expect(xlsxRows[0]?.rowNumber).toBe(2);

    const csvPlan = buildRunPlan(
      csvRows,
      profile,
      new Date("2026-06-09T12:00:00.000Z"),
      "run_csv_fixture_001",
    );
    const xlsxPlan = buildRunPlan(
      xlsxRows,
      profile,
      new Date("2026-06-09T12:00:00.000Z"),
      "run_xlsx_fixture_001",
    );

    expect(xlsxPlan.source).toEqual(csvPlan.source);
  });

  test("local smoke fixture maps to synthetic dev target ids", async () => {
    const rows = await readWorkbook("./fixtures/members-local-smoke.csv");
    const localSmokeProfile = JSON.parse(
      await readFile("./examples/profile.tetra.local-smoke.json", "utf8"),
    ) as MappingProfile;

    const plan = buildRunPlan(
      rows,
      localSmokeProfile,
      new Date("2026-06-10T12:00:00.000Z"),
      "run_smoke",
    );
    const serialized = JSON.stringify(plan);

    expect(plan.tenantId).toBe("tenant_local_tetra");
    expect(plan.environment).toBe("dev");
    expect(plan.operations).toHaveLength(1);
    expect(plan.blockedRows).toHaveLength(0);
    expect(plan.operations[0]?.accessGroup.id).toBe("smoke-access-group");
    expect(plan.operations[0]?.product.id).toBe("smoke-course-section");
    expect(serialized).not.toContain("smoke.member@example.test");
    expect(serialized).not.toContain("Membro Smoke");
  });
});

describe("buildRunPlan", () => {
  test("builds a redacted plan, deduplicates lesson rows, and blocks unmapped labels", () => {
    const rows = csvRowsToSourceRows([
      {
        Aluno: "Membro Um",
        "E-mail": "MEMBRO.UM@EXAMPLE.TEST",
        Telefone: "11999990000",
        Grupo: "Grupo Fake",
        Curso: "Curso Fake",
        "Porcentagem da Aula": "100",
        Concluida: "1",
        "Data de Acesso": "2026-01-10",
      },
      {
        Aluno: "Membro Um",
        "E-mail": "membro.um@example.test",
        Telefone: "11999990000",
        Grupo: "Grupo Fake",
        Curso: "Curso Fake",
        "Porcentagem da Aula": "50",
        Concluida: "0",
        "Data de Acesso": "2026-01-11",
      },
      {
        Aluno: "Membro Dois",
        "E-mail": "membro.dois@example.test",
        Grupo: "Outro Grupo",
        Curso: "Curso Fake",
      },
      {
        Aluno: "Membro Tres",
        "E-mail": "membro.tres@example.test",
        Grupo: "Grupo Fake",
        Curso: "Outro Curso",
      },
    ]);

    const plan = buildRunPlan(
      rows,
      profile,
      new Date("2026-06-09T12:00:00.000Z"),
      "run_fake_001",
    );
    const serialized = JSON.stringify(plan);

    expect(plan.source).toEqual({
      totalRows: 4,
      executableRows: 1,
      blockedRows: 2,
      evidenceOnlyRows: 0,
      duplicateRows: 1,
    });
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({
      accessGroup: { id: "ag_fake_001", name: "Grupo Fake" },
      product: { id: "prod_fake_001", name: "Curso Fake" },
      action: "ensure_member_access_and_enrollment",
      evidence: {
        hasProgressPercent: true,
        hasCompletionFlag: true,
        hasHistoricalAccessDate: true,
        progressWritePlanned: false,
      },
    });
    expect(plan.operations[0]?.sourceRefs).toHaveLength(2);
    expect(plan.blockedRows.map((row) => row.reasons)).toEqual([
      ["access group is missing or not mapped"],
      ["product is missing or not mapped"],
    ]);
    expect(serialized).not.toContain("MEMBRO.UM@EXAMPLE.TEST");
    expect(serialized).not.toContain("membro.um@example.test");
    expect(serialized).not.toContain("11999990000");
    expect(serialized).not.toContain("Membro Um");
  });
});

describe("assertExecutionAllowed", () => {
  test("requires a matching approval file for production execute", () => {
    const plan = {
      runId: "run_fake_001",
      tenantId: "tenant_fake_001",
      environment: "production" as const,
    };

    expect(() => assertExecutionAllowed({ execute: true, plan })).toThrow(
      "Production execute requires an approval file.",
    );

    const approval: ApprovalFile = {
      runId: "run_fake_001",
      tenantId: "tenant_fake_001",
      environment: "production",
      approvedAt: "2026-06-09T12:00:00.000Z",
    };

    expect(() => assertExecutionAllowed({ execute: true, plan, approval })).not.toThrow();
  });
});

describe("executeRun", () => {
  test("executes valid operations through the fake adapter without progress writes or PII", () => {
    const plan = buildRunPlan(
      csvRowsToSourceRows([
        {
          Aluno: "Membro Um",
          "E-mail": "membro.um@example.test",
          Telefone: "11999990000",
          Grupo: "Grupo Fake",
          Curso: "Curso Fake",
        },
      ]),
      profile,
      new Date("2026-06-09T12:00:00.000Z"),
      "run_fake_execute_001",
    );

    const report = executeRun(plan, {
      adapter: EXECUTE_ADAPTERS.fake,
      now: new Date("2026-06-09T12:01:00.000Z"),
    });
    const serialized = JSON.stringify(report);

    expect(report.summary).toEqual({
      attemptedOperations: 1,
      succeededOperations: 1,
      failedOperations: 0,
      skippedBlockedRows: 0,
      progressWrites: 0,
    });
    expect(report.results[0]).toMatchObject({
      status: "succeeded",
      sourceRefCount: 1,
      accessGroupId: "ag_fake_001",
      productId: "prod_fake_001",
      progressWritePlanned: false,
    });
    expect(serialized).not.toContain("membro.um@example.test");
    expect(serialized).not.toContain("Membro Um");
    expect(serialized).not.toContain("11999990000");
  });
});

describe("openMigrationLedger", () => {
  test("records dry-run and fake execute summaries without raw source PII", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "student-migration-"));
    const ledgerPath = join(tempDir, "runs.sqlite");

    try {
      const plan = buildRunPlan(
        csvRowsToSourceRows([
          {
            Aluno: "Membro Um",
            "E-mail": "membro.um@example.test",
            Telefone: "11999990000",
            Grupo: "Grupo Fake",
            Curso: "Curso Fake",
          },
        ]),
        profile,
        new Date("2026-06-09T12:00:00.000Z"),
        "run_fake_ledger_001",
      );
      const report = executeRun(plan, {
        adapter: EXECUTE_ADAPTERS.fake,
        now: new Date("2026-06-09T12:01:00.000Z"),
      });

      const ledger = await openMigrationLedger(ledgerPath);
      ledger.recordDryRun(plan);
      ledger.recordExecute(report);
      ledger.close();

      const database = new Database(ledgerPath, { readonly: true });
      const storedRun = database
        .query("select total_rows, executable_rows, blocked_rows from runs where run_id = ?")
        .get("run_fake_ledger_001");
      const storedResult = database
        .query("select status, source_ref_count, member_ref from operation_results where run_id = ?")
        .get("run_fake_ledger_001");
      const rawText = [
        JSON.stringify(database.query("select * from runs").all()),
        JSON.stringify(database.query("select * from execute_reports").all()),
        JSON.stringify(database.query("select * from operation_results").all()),
      ].join("\n");
      database.close();

      expect(storedRun).toEqual({ total_rows: 1, executable_rows: 1, blocked_rows: 0 });
      expect(storedResult).toMatchObject({
        status: "succeeded",
        source_ref_count: 1,
      });
      expect(String((storedResult as { member_ref: string }).member_ref)).toStartWith(
        "fake_member_",
      );
      expect(rawText).not.toContain("membro.um@example.test");
      expect(rawText).not.toContain("Membro Um");
      expect(rawText).not.toContain("11999990000");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
