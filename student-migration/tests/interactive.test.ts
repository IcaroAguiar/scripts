import { describe, expect, test } from "bun:test";
import { InputRenderable, SelectRenderable, type CliRenderer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExecutionCompleteText,
  buildPlanReviewText,
  runInteractiveMigrationWithRenderer,
} from "../src/interactive";
import { buildInteractiveOptions } from "../src/interactive-model";
import {
  executePreparedMigrationPlan,
  prepareMigrationPlan,
  runMigration,
  assertLegacyPrepared,
} from "../src/run-migration";

function getWizardControl(renderer: CliRenderer): InputRenderable | SelectRenderable {
  const control = renderer.root.findDescendantById("control");

  if (control instanceof InputRenderable || control instanceof SelectRenderable) {
    return control;
  }

  throw new Error("Expected the OpenTUI wizard control to be mounted");
}

describe("buildInteractiveOptions", () => {
  test("derives storage output paths from the input filename when omitted", () => {
    const options = buildInteractiveOptions({
      input: '"/Users/icaroaguiar/Downloads/20260325130201596LTKURS (1).csv"',
      profile: "./storage/profile.real-dev.json",
      mode: "dry-run",
    });

    expect(options).toEqual({
      input: "/Users/icaroaguiar/Downloads/20260325130201596LTKURS (1).csv",
      profile: "./storage/profile.real-dev.json",
      output: "storage/20260325130201596ltkurs-1-plan.json",
      execute: false,
      ledger: "storage/20260325130201596ltkurs-1-runs.sqlite",
      executeReport: "storage/20260325130201596ltkurs-1-execute.json",
    });
  });

  test("builds dry-run options from wizard answers with explicit output overrides", () => {
    const options = buildInteractiveOptions({
      input: "./fixtures/members-progress.xlsx",
      profile: "./examples/profile.tetra.fake.json",
      mode: "dry-run",
      output: "./storage/custom-plan.json",
      ledger: "./storage/custom-runs.sqlite",
      executeReport: "./storage/custom-execute.json",
    });

    expect(options).toEqual({
      input: "./fixtures/members-progress.xlsx",
      profile: "./examples/profile.tetra.fake.json",
      output: "./storage/custom-plan.json",
      execute: false,
      ledger: "./storage/custom-runs.sqlite",
      executeReport: "./storage/custom-execute.json",
    });
  });

  test("builds fake execute options without enabling real adapters", () => {
    const options = buildInteractiveOptions({
      input: "./fixtures/members-progress.xlsx",
      profile: "./examples/profile.tetra.fake.json",
      mode: "execute-fake",
      output: "./storage/custom-plan.json",
      ledger: "./storage/custom-runs.sqlite",
      executeReport: "./storage/custom-execute.json",
    });

    expect(options).toMatchObject({
      execute: true,
      adapter: "fake",
      output: "./storage/custom-plan.json",
      ledger: "./storage/custom-runs.sqlite",
      executeReport: "./storage/custom-execute.json",
    });
  });

  test("builds gated tetra-dev execute options for the TUI dev mode", () => {
    const options = buildInteractiveOptions({
      input: "./fixtures/members-progress.xlsx",
      profile: "./examples/profile.tetra.fake.json",
      mode: "execute-dev",
      output: "./storage/dev-plan.json",
      ledger: "./storage/dev-runs.sqlite",
      executeReport: "./storage/dev-execute.json",
      envFile: "./storage/dev.env",
    });

    expect(options).toMatchObject({
      execute: true,
      adapter: "tetra-dev",
      allowDevExecute: true,
      preflightDev: true,
      output: "./storage/dev-plan.json",
      ledger: "./storage/dev-runs.sqlite",
      executeReport: "./storage/dev-execute.json",
      envFile: "./storage/dev.env",
    });
  });


  test("normalizes local paths pasted with home, quotes, or spaces", () => {
    const home = process.env.HOME;
    if (!home) {
      throw new Error("HOME is required for this test");
    }

    const options = buildInteractiveOptions({
      input: "'~/Downloads/Membros Tetra.xlsx'",
      profile: "\"./examples/profile.tetra.fake.json\"",
      mode: "dry-run",
      output: "./storage/plano teste.json",
    });

    expect(options.input).toBe(`${home}/Downloads/Membros Tetra.xlsx`);
    expect(options.profile).toBe("./examples/profile.tetra.fake.json");
    expect(options.output).toBe("./storage/plano teste.json");
  });
});

describe("interactive command contract", () => {
  test("exposes bun run import as the simple TUI command", async () => {
    const packageJson = JSON.parse(await readFile("./package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.import).toBe("bun run src/index.ts --tui");
  });

  test("renders the reviewed plan in the completion text for tetra-dev", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "student-migration-tui-complete-"));

    try {
      const prepared = assertLegacyPrepared(await prepareMigrationPlan({
        input: "./fixtures/members-progress.xlsx",
        profile: "./examples/profile.tetra.fake.json",
        output: join(tempDir, "plan.json"),
        execute: true,
        adapter: "fake",
        ledger: join(tempDir, "runs.sqlite"),
        executeReport: join(tempDir, "execute.json"),
      }));
      const text = buildExecutionCompleteText(prepared, {
        executeReportPath: join(tempDir, "execute.json"),
        executeSummary: {
          adapter: "tetra-dev",
          attemptedOperations: 1,
          succeededOperations: 1,
          skippedBlockedRows: 2,
        },
      });

      expect(text).toContain("Execute tetra-dev concluido");
      expect(text).toContain("Plano executado");
      expect(text).toContain("Plano redigido");
      expect(text).toContain("Operacoes validas: 1");
      expect(text).not.toContain("membro.um@example.test");
      expect(text).not.toContain("Membro Um");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("renders the redacted plan inside the TUI review before execution", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "student-migration-tui-review-"));

    try {
      const prepared = assertLegacyPrepared(await prepareMigrationPlan({
        input: "./fixtures/members-progress.xlsx",
        profile: "./examples/profile.tetra.fake.json",
        output: join(tempDir, "plan.json"),
        execute: true,
        adapter: "fake",
        ledger: join(tempDir, "runs.sqlite"),
        executeReport: join(tempDir, "execute.json"),
      }));
      const text = buildPlanReviewText(prepared, {
        input: "./fixtures/members-progress.xlsx",
        profile: "./examples/profile.tetra.fake.json",
        output: join(tempDir, "plan.json"),
        execute: true,
        adapter: "tetra-dev",
        ledger: join(tempDir, "runs.sqlite"),
        executeReport: join(tempDir, "execute.json"),
      });

      expect(text).toContain("Plano redigido");
      expect(text).toContain("Operacoes validas: 1");
      expect(text).toContain("Linhas bloqueadas");
      expect(text).toContain("Artefatos redigidos");
      expect(text).toContain(`Plano JSON: ${join(tempDir, "plan.json")}`);
      expect(text).toContain("Relatorio execute previsto");
      expect(text).not.toContain("membro.um@example.test");
      expect(text).not.toContain("Membro Um");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("walks through execute-dev review and confirmation with OpenTUI test renderer", async () => {
    const { renderer, mockInput, waitForFrame, flush } = await createTestRenderer({
      width: 120,
      height: 60,
    });
    const calls: string[] = [];
    const finished = runInteractiveMigrationWithRenderer(renderer, {
      prepareMigrationPlan: async (options) => {
        calls.push(
          [
            "prepare",
            options.input,
            options.output,
            options.ledger,
            options.executeReport,
            options.adapter,
            options.preflightDev ? "preflight" : "no-preflight",
          ].join(":"),
        );
        return {
          plan: {
            runId: "run_tui_dev",
            generatedAt: "2026-06-10T12:00:00.000Z",
            dryRun: true,
            tenantId: "tenant_local_tetra",
            environment: "dev",
            source: {
              totalRows: 1,
              executableRows: 1,
              blockedRows: 0,
              evidenceOnlyRows: 0,
              duplicateRows: 0,
            },
            operations: [
              {
                operationId: "op_tui_dev",
                sourceRefs: [{ sheetName: "csv", rowNumber: 2, rowHash: "row_hash" }],
                member: {
                  memberHash: "hash_redacted_member",
                  hasName: true,
                  hasPhoneEvidence: false,
                },
                accessGroup: { id: "smoke-access-group", name: "Grupo Smoke Local" },
                product: { id: "smoke-course-section", name: "Curso Smoke Local", type: "COURSE" },
                idempotencyKey: "idem_tui_dev",
                action: "ensure_member_access_and_enrollment",
                evidence: {
                  hasProgressPercent: true,
                  hasCompletionFlag: false,
                  hasHistoricalAccessDate: false,
                  progressWritePlanned: false,
                },
              },
            ],
            blockedRows: [],
            evidenceOnlyRows: [],
          },
          planPath: "/tmp/tui-plan.json",
          privateContext: {
            runId: "run_tui_dev",
            tenantId: "tenant_local_tetra",
            environment: "dev",
            operations: [
              {
                operationId: "op_tui_dev",
                member: { email: "smoke.member@example.test", name: "Membro Smoke" },
              },
            ],
          },
        };
      },
      preflightPreparedMigrationPlan: async () => {
        calls.push("preflight");
        return {
          runId: "run_tui_dev",
          checkedAt: "2026-06-10T12:00:01.000Z",
          adapter: "tetra-dev",
          tenantId: "tenant_local_tetra",
          environment: "dev",
          summary: {
            checkedOperations: 1,
            readyOperations: 1,
            failedOperations: 0,
            blockedRows: 0,
          },
          results: [
            {
              operationId: "op_tui_dev",
              status: "ready",
              sourceRefCount: 1,
              memberRef: "hash_redacted_member",
              accessGroupId: "smoke-access-group",
              productId: "smoke-course-section",
            },
          ],
        };
      },
      executePreparedMigrationPlan: async (_prepared, options) => {
        calls.push(`execute:${options.adapter}`);
        return {
          executeReportPath: "/tmp/tui-execute.json",
          executeSummary: {
            adapter: "tetra-dev",
            attemptedOperations: 1,
            succeededOperations: 1,
            skippedBlockedRows: 0,
          },
        };
      },
    });

    const submitInput = async (prompt: string, value?: string) => {
      await waitForFrame((frame) => frame.includes(prompt));
      const control = getWizardControl(renderer);
      expect(control).toBeInstanceOf(InputRenderable);
      if (value !== undefined) {
        (control as InputRenderable).value = value;
      }
      (control as InputRenderable).submit();
      await flush();
    };

    const selectOption = async (label: string, moveDown = 0) => {
      await waitForFrame((frame) => frame.includes(label));
      const control = getWizardControl(renderer);
      expect(control).toBeInstanceOf(SelectRenderable);
      for (let index = 0; index < moveDown; index += 1) {
        (control as SelectRenderable).moveDown();
      }
      (control as SelectRenderable).selectCurrent();
      await flush();
    };

    await submitInput("Planilha local CSV/XLSX", "./fixtures/members-local-smoke.csv");
		await selectOption("Usar arquivo de perfil existente", 1);
    await submitInput("Caminho do perfil de mapeamento aprovado");
    await selectOption("Execute dev", 2);
    await submitInput("Env-file local opcional", "./storage/tetra-dev.env");
    await selectOption("Rodar agora");

    const reviewFrame = await waitForFrame((frame) => frame.includes("Revisao do plano"));
    expect(reviewFrame).toContain("Plano redigido");
    expect(reviewFrame).toContain("Preflight tetra-dev");
    expect(reviewFrame).toContain("Operacoes prontas: 1");
    expect(reviewFrame).not.toContain("smoke.member@example.test");
    expect(reviewFrame).not.toContain("Membro Smoke");

    await selectOption("Executar dev agora");

    const completeFrame = await waitForFrame((frame) => frame.includes("Execute tetra-dev concluido"));
    expect(completeFrame).toContain("Operacoes com sucesso: 1");
    expect(completeFrame).toContain("Plano executado");
    expect(calls).toEqual([
      [
        "prepare",
        "./fixtures/members-local-smoke.csv",
        "storage/members-local-smoke-plan.json",
        "storage/members-local-smoke-runs.sqlite",
        "storage/members-local-smoke-execute.json",
        "tetra-dev",
        "preflight",
      ].join(":"),
      "preflight",
      "execute:tetra-dev",
    ]);

    mockInput.pressEscape();
    await finished;
  });

  test("cria um perfil v2 completo pela TUI, com validacao de campos", async () => {
    const { renderer, mockInput, waitForFrame, flush } = await createTestRenderer({
      width: 120,
      height: 60,
    });
    let capturedProfilePath = "";
    const finished = runInteractiveMigrationWithRenderer(renderer, {
      prepareMigrationPlan: async (options) => {
        capturedProfilePath = options.profile ?? "";
        return {
          plan: {
            runId: "run_tui_create",
            generatedAt: "2026-07-03T12:00:00.000Z",
            dryRun: true,
            layout: "themembers-consumo",
            tenantId: "tenant_local_tetra",
            environment: "local",
            accessGroup: {
              mode: "create",
              name: "Migracao Periodo Teste",
              periodicity: "YEARLY",
              periodicityValue: 1,
            },
            enrollmentWindow: {
              accessStartsAt: "2026-01-15T03:00:00.000Z",
              accessEndsAt: "2027-01-15T03:00:00.000Z",
              periodicity: "YEARLY",
              periodicityValue: 1,
            },
            source: {
              totalRows: 3,
              memberOperations: 2,
              plannedEnrollments: 2,
              plannedProgressWrites: 2,
              blockedRows: 0,
              progressOnlyBlockedRows: 0,
            },
            blockedReasonCounts: {},
            catalog: {
              ambiguousCourseTitles: [],
              unresolvedCourseTitles: [],
              unresolvedLessonTitles: [],
            },
            operations: [],
            blockedRows: [],
          },
          planPath: "/tmp/tui-create-plan.json",
          privateContext: {
            runId: "run_tui_create",
            tenantId: "tenant_local_tetra",
            environment: "local",
            members: [],
          },
        } as never;
      },
      preflightPreparedMigrationPlan: async () => {
        throw new Error("nao deve preflight em dry-run");
      },
      executePreparedMigrationPlan: async () => {
        throw new Error("nao deve executar em dry-run");
      },
    });

    const submitInput = async (prompt: string, value?: string) => {
      await waitForFrame((frame) => frame.includes(prompt));
      const control = getWizardControl(renderer);
      expect(control).toBeInstanceOf(InputRenderable);
      if (value !== undefined) {
        (control as InputRenderable).value = value;
      }
      (control as InputRenderable).submit();
      await flush();
    };

    const selectOption = async (label: string, moveDown = 0) => {
      await waitForFrame((frame) => frame.includes(label));
      const control = getWizardControl(renderer);
      expect(control).toBeInstanceOf(SelectRenderable);
      for (let index = 0; index < moveDown; index += 1) {
        (control as SelectRenderable).moveDown();
      }
      (control as SelectRenderable).selectCurrent();
      await flush();
    };

    await submitInput("Planilha local CSV/XLSX", "./fixtures/themembers-consumo.csv");
    await selectOption("Criar novo perfil agora");
    await submitInput("Nome desta migracao", "Periodo Teste TUI");
    await submitInput("Tenant de destino", "tenant_local_tetra");
    await selectOption("Local");
    await selectOption("Criar um grupo novo");
    await submitInput("Nome do grupo de acesso a criar", "Migracao Periodo Teste");

    // valida a data: primeiro um valor invalido, que deve manter o passo com erro
    await submitInput("Inicio da matricula", "15/01/2026");
    const errorFrame = await waitForFrame((frame) => frame.includes("YYYY-MM-DD (ex.: 2026-01-15)"));
    expect(errorFrame).toContain(">>");
    await submitInput("Inicio da matricula", "2026-01-15");

    await selectOption("Anual (YEARLY)");
    await submitInput("Multiplicador da periodicidade", "1");
    await selectOption("Usar catalog map local");
    await selectOption("Dry-run redigido");
    await selectOption("Rodar agora");

    await waitForFrame((frame) => frame.includes("Revisao do plano"));

    expect(capturedProfilePath).toContain("profile.periodo-teste-tui");
    const savedProfile = JSON.parse(await readFile(capturedProfilePath, "utf8"));
    expect(savedProfile).toMatchObject({
      version: 2,
      layout: "themembers-consumo",
      tenantId: "tenant_local_tetra",
      environment: "local",
      accessGroup: {
        mode: "create",
        name: "Migracao Periodo Teste",
        periodicity: "YEARLY",
        periodicityValue: 1,
      },
      enrollmentWindow: {
        accessStartsAt: "2026-01-15",
        periodicity: "YEARLY",
        periodicityValue: 1,
      },
    });
    await rm(capturedProfilePath, { force: true });

    mockInput.pressEscape();
    await finished;
  });
});

describe("runMigration progress", () => {
  test("emits redacted progress events for the local dry-run path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "student-migration-progress-"));
    const events: string[] = [];

    try {
      await runMigration({
        input: "./fixtures/members-progress.xlsx",
        profile: "./examples/profile.tetra.fake.json",
        output: join(tempDir, "plan.json"),
        execute: false,
        ledger: join(tempDir, "runs.sqlite"),
        executeReport: join(tempDir, "execute.json"),
        onProgress: (event) => events.push(event.message),
      });

      expect(events).toEqual([
        "Validando caminhos locais",
        "Lendo planilha",
        "Aplicando perfil e montando plano",
        "Gravando plano redigido",
        "Registrando dry-run no ledger",
        "Dry-run concluido",
      ]);
      expect(events.join("\n")).not.toContain("membro.um@example.test");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("can prepare a reviewed plan and execute the same run later", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "student-migration-prepare-execute-"));

    try {
      const options = {
        input: "./fixtures/members-progress.xlsx",
        profile: "./examples/profile.tetra.fake.json",
        output: join(tempDir, "plan.json"),
        execute: true,
        adapter: "fake",
        ledger: join(tempDir, "runs.sqlite"),
        executeReport: join(tempDir, "execute.json"),
      };
      const prepared = assertLegacyPrepared(await prepareMigrationPlan(options));
      const executed = await executePreparedMigrationPlan(prepared.plan, options);
      const report = JSON.parse(await readFile(executed.executeReportPath, "utf8")) as {
        runId: string;
      };

      expect(report.runId).toBe(prepared.plan.runId);
      expect(executed.executeSummary.attemptedOperations).toBe(prepared.plan.operations.length);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
