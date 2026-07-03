import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLegacyPrepared, executePreparedMigrationPlan, prepareMigrationPlan } from "../src/run-migration";

describe("private execution context", () => {
  test("keeps IAM member inputs in memory without persisting them to the redacted plan", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "student-migration-private-context-"));

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
      const serializedPlan = await readFile(prepared.planPath, "utf8");
      const operation = prepared.plan.operations[0];

      expect(operation).toBeDefined();

      expect(prepared.privateContext).toEqual({
        runId: prepared.plan.runId,
        tenantId: "tenant_fake_001",
        environment: "dev",
        operations: [
          {
            operationId: operation!.operationId,
            member: {
              email: "membro.um@example.test",
              name: "Membro Um",
            },
          },
        ],
      });
      expect(serializedPlan).not.toContain("membro.um@example.test");
      expect(serializedPlan).not.toContain("Membro Um");
      expect(serializedPlan).not.toContain("11999990000");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("executes a prepared migration without leaking private context to report output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "student-migration-private-execute-"));

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
      const executed = await executePreparedMigrationPlan(prepared, options);
      const report = await readFile(executed.executeReportPath, "utf8");

      expect(report).toContain(prepared.plan.runId);
      expect(report).not.toContain("membro.um@example.test");
      expect(report).not.toContain("Membro Um");
      expect(report).not.toContain("11999990000");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
