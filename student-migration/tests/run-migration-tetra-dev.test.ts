import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTetraDevConfigFromEnv,
  loadTetraDevConfigFromEnvFile,
  runMigration,
} from "../src/run-migration";

describe("runMigration tetra-dev adapter wiring", () => {
  test("requires an explicit dev execute gate before tetra-dev mutations", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "student-migration-tetra-dev-gate-"));

    try {
      await expect(
        runMigration({
          input: "./fixtures/members-progress.xlsx",
          profile: "./examples/profile.tetra.fake.json",
          output: join(tempDir, "plan.json"),
          execute: true,
          adapter: "tetra-dev",
          ledger: join(tempDir, "runs.sqlite"),
          executeReport: join(tempDir, "execute.json"),
        }),
      ).rejects.toThrow("Tetra dev execute requires an explicit dev execution gate.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("executes tetra-dev through injected clients and writes a redacted report", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "student-migration-tetra-dev-execute-"));

    try {
      const result = await runMigration({
        input: "./fixtures/members-progress.xlsx",
        profile: "./examples/profile.tetra.fake.json",
        output: join(tempDir, "plan.json"),
        execute: true,
        adapter: "tetra-dev",
        allowDevExecute: true,
        ledger: join(tempDir, "runs.sqlite"),
        executeReport: join(tempDir, "execute.json"),
        tetraDevClients: {
          iam: {
            findOrCreateMembers: async () => [
              { email: "membro.um@example.test", userId: "user_001", created: false },
            ],
          },
          enrollments: {
            getAccessGroup: async () => ({ id: "ag_fake_001" }),
            listAccessGroupProducts: async () => [{ productId: "prod_fake_001" }],
            addAccessGroupMember: async () => ({}),
            findExistingEnrollment: async () => null,
            createEnrollment: async () => ({}),
          },
        },
      });
      const report = await readFile(result.executeReportPath!, "utf8");

      expect(result.executeSummary).toEqual({
        adapter: "tetra-dev",
        attemptedOperations: 1,
        succeededOperations: 1,
        skippedBlockedRows: 2,
      });
      expect(report).toContain('"adapter": "tetra-dev"');
      expect(report).not.toContain("membro.um@example.test");
      expect(report).not.toContain("Membro Um");
      expect(report).not.toContain("11999990000");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("runs a non-mutating tetra-dev preflight through injected clients", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "student-migration-tetra-dev-preflight-"));
    const calls: string[] = [];

    try {
      const result = await runMigration({
        input: "./fixtures/members-progress.xlsx",
        profile: "./examples/profile.tetra.fake.json",
        output: join(tempDir, "plan.json"),
        execute: false,
        preflightDev: true,
        ledger: join(tempDir, "runs.sqlite"),
        executeReport: join(tempDir, "execute.json"),
        tetraDevClients: {
          iam: {
            findOrCreateMembers: async () => {
              calls.push("iam");
              return [];
            },
          },
          enrollments: {
            getAccessGroup: async () => ({ id: "ag_fake_001" }),
            listAccessGroupProducts: async () => [{ productId: "prod_fake_001" }],
            addAccessGroupMember: async () => {
              calls.push("add-member");
              return {};
            },
            findExistingEnrollment: async () => {
              calls.push("find-enrollment");
              return null;
            },
            createEnrollment: async () => {
              calls.push("create-enrollment");
              return {};
            },
          },
        },
      });

      expect(calls).toEqual([]);
      expect(result.preflightSummary).toEqual({
        checkedOperations: 1,
        readyOperations: 1,
        failedOperations: 0,
        blockedRows: 2,
      });
      expect(result.executeSummary).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("loadTetraDevConfigFromEnv", () => {
  test("loads local Tetra dev config from environment names without secret values in errors", () => {
    expect(
      loadTetraDevConfigFromEnv({
        TETRA_IAM_URI: "http://localhost:3335",
        TETRA_ENROLLMENTS_URI: "http://localhost:3338",
        IAM_OAUTH_CLIENT_ID: "tetra-imports-service",
        IAM_OAUTH_CLIENT_SECRET: "not-a-real-test-placeholder",
      }),
    ).toEqual({
      iamBaseUrl: "http://localhost:3335",
      enrollmentsBaseUrl: "http://localhost:3338",
      clientId: "tetra-imports-service",
      clientSecret: "not-a-real-test-placeholder",
      scope: "iam:provision-users",
    });

    expect(() => loadTetraDevConfigFromEnv({})).toThrow(
      "Missing Tetra dev config env vars: TETRA_IAM_URI or IAM_API_BASE_URL, TETRA_ENROLLMENTS_URI or ENROLLMENTS_API_BASE_URL, IAM_OAUTH_CLIENT_ID or TETRA_IAM_CLIENT_ID or IMPORTS_OAUTH_CLIENT_ID, IAM_OAUTH_CLIENT_SECRET or TETRA_IAM_CLIENT_SECRET or IMPORTS_OAUTH_CLIENT_SECRET",
    );
  });

  test("loads existing local Tetra service env aliases", () => {
    expect(
      loadTetraDevConfigFromEnv({
        IAM_API_BASE_URL: "http://localhost:3335",
        ENROLLMENTS_API_BASE_URL: "http://localhost:3338",
        IMPORTS_OAUTH_CLIENT_SECRET: "not-a-real-test-placeholder",
      }),
    ).toEqual({
      iamBaseUrl: "http://localhost:3335",
      enrollmentsBaseUrl: "http://localhost:3338",
      clientId: "tetra-imports-service",
      clientSecret: "not-a-real-test-placeholder",
      scope: "iam:provision-users",
    });
  });

  test("loads tetra-dev config from an env file without printing secret values", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "student-migration-env-file-"));
    const envPath = join(tempDir, "tetra-dev.env");

    try {
      await writeFile(
        envPath,
        [
          "IAM_API_BASE_URL=http://localhost:3335",
          "ENROLLMENTS_API_BASE_URL=http://localhost:3338",
          "IMPORTS_OAUTH_CLIENT_SECRET='not-a-real-test-placeholder'",
          "TETRA_MEMBER_MIGRATION_SERVICE_SCOPE=iam:provision-users",
        ].join("\n"),
      );

      await expect(loadTetraDevConfigFromEnvFile(envPath)).resolves.toEqual({
        iamBaseUrl: "http://localhost:3335",
        enrollmentsBaseUrl: "http://localhost:3338",
        clientId: "tetra-imports-service",
        clientSecret: "not-a-real-test-placeholder",
        scope: "iam:provision-users",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
