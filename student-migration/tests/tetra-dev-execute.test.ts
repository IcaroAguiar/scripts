import { describe, expect, test } from "bun:test";
import { assertLegacyPrepared, prepareMigrationPlan } from "../src/run-migration";
import { executeTetraDevRun, preflightTetraDevRun } from "../src/tetra-dev-execute";

describe("executeTetraDevRun", () => {
  test("preflights target group and product without calling IAM or mutating endpoints", async () => {
    const prepared = assertLegacyPrepared(await prepareMigrationPlan({
      input: "./fixtures/members-progress.xlsx",
      profile: "./examples/profile.tetra.fake.json",
      output: "./storage/tetra-dev-readonly-preflight-plan.json",
      execute: false,
      ledger: "./storage/tetra-dev-readonly-preflight-runs.sqlite",
      executeReport: "./storage/tetra-dev-readonly-preflight-execute.json",
    }));
    const calls: string[] = [];

    const report = await preflightTetraDevRun(prepared, {
      enrollments: {
        getAccessGroup: async (accessGroupId) => {
          calls.push(`get-group:${accessGroupId}`);
          return { id: accessGroupId };
        },
        listAccessGroupProducts: async (accessGroupId) => {
          calls.push(`list-products:${accessGroupId}`);
          return [{ productId: "prod_fake_001" }];
        },
      },
    });

    expect(calls).toEqual(["get-group:ag_fake_001", "list-products:ag_fake_001"]);
    expect(report.summary).toEqual({
      checkedOperations: 1,
      readyOperations: 1,
      failedOperations: 0,
      blockedRows: 2,
    });
    expect(report.results[0]).toMatchObject({
      status: "ready",
      accessGroupId: "ag_fake_001",
      productId: "prod_fake_001",
    });
    expect(JSON.stringify(report)).not.toContain("membro.um@example.test");
    expect(JSON.stringify(report)).not.toContain("Membro Um");
  });

  test("uses private context for IAM/enrollments calls and returns a redacted report", async () => {
    const calls: string[] = [];
    const prepared = assertLegacyPrepared(await prepareMigrationPlan({
      input: "./fixtures/members-progress.xlsx",
      profile: "./examples/profile.tetra.fake.json",
      output: "./storage/tetra-dev-boundary-plan.json",
      execute: true,
      adapter: "fake",
      ledger: "./storage/tetra-dev-boundary-runs.sqlite",
      executeReport: "./storage/tetra-dev-boundary-execute.json",
    }));

    const report = await executeTetraDevRun(prepared, {
      iam: {
        findOrCreateMembers: async (input) => {
          calls.push(`iam:${input.members[0]?.email}:${input.members[0]?.name}`);
          return [{ email: "membro.um@example.test", userId: "user_001", created: false }];
        },
      },
      enrollments: {
        getAccessGroup: async () => ({ id: "ag_fake_001" }),
        listAccessGroupProducts: async () => [{ productId: "prod_fake_001" }],
        addAccessGroupMember: async (input) => {
          calls.push(`group:${input.accessGroupId}:${input.userId}:${input.email}`);
          return {};
        },
        findExistingEnrollment: async (input) => {
          calls.push(`find-enrollment:${input.userId}:${input.productId}:${input.accessGroupId}`);
          return null;
        },
        createEnrollment: async (input) => {
          calls.push(`create-enrollment:${input.userId}:${input.productId}:${input.accessGroupId}`);
          return {};
        },
      },
    });
    const serialized = JSON.stringify(report);

    expect(calls).toEqual([
      "iam:membro.um@example.test:Membro Um",
      "group:ag_fake_001:user_001:membro.um@example.test",
      "find-enrollment:user_001:prod_fake_001:ag_fake_001",
      "create-enrollment:user_001:prod_fake_001:ag_fake_001",
    ]);
    expect(report.adapter).toBe("tetra-dev");
    expect(report.summary).toMatchObject({
      attemptedOperations: 1,
      succeededOperations: 1,
      failedOperations: 0,
      skippedBlockedRows: 2,
      progressWrites: 0,
    });
    expect(report.results[0]).toMatchObject({
      status: "succeeded",
      memberRef: "tetra_user_user_001",
      accessGroupId: "ag_fake_001",
      productId: "prod_fake_001",
      progressWritePlanned: false,
    });
    expect(serialized).not.toContain("membro.um@example.test");
    expect(serialized).not.toContain("Membro Um");
    expect(serialized).not.toContain("11999990000");
  });

  test("treats an existing matching enrollment as idempotent success", async () => {
    const prepared = assertLegacyPrepared(await prepareMigrationPlan({
      input: "./fixtures/members-progress.xlsx",
      profile: "./examples/profile.tetra.fake.json",
      output: "./storage/tetra-dev-idempotent-plan.json",
      execute: true,
      adapter: "fake",
      ledger: "./storage/tetra-dev-idempotent-runs.sqlite",
      executeReport: "./storage/tetra-dev-idempotent-execute.json",
    }));
    let createEnrollmentCalls = 0;

    const report = await executeTetraDevRun(prepared, {
      iam: {
        findOrCreateMembers: async () => [
          { email: "membro.um@example.test", userId: "user_001", created: false },
        ],
      },
      enrollments: {
        getAccessGroup: async () => ({ id: "ag_fake_001" }),
        listAccessGroupProducts: async () => [{ productId: "prod_fake_001" }],
        addAccessGroupMember: async () => ({}),
        findExistingEnrollment: async () => ({ id: "enrollment_existing" }),
        createEnrollment: async () => {
          createEnrollmentCalls += 1;
          return {};
        },
      },
    });

    expect(createEnrollmentCalls).toBe(0);
    expect(report.results[0]?.status).toBe("succeeded");
    expect(report.results[0]?.errorCode).toBeUndefined();
  });

  test("blocks invalid targets before IAM provisioning", async () => {
    const prepared = assertLegacyPrepared(await prepareMigrationPlan({
      input: "./fixtures/members-progress.xlsx",
      profile: "./examples/profile.tetra.fake.json",
      output: "./storage/tetra-dev-preflight-plan.json",
      execute: true,
      adapter: "fake",
      ledger: "./storage/tetra-dev-preflight-runs.sqlite",
      executeReport: "./storage/tetra-dev-preflight-execute.json",
    }));
    let iamCalls = 0;

    const report = await executeTetraDevRun(prepared, {
      iam: {
        findOrCreateMembers: async () => {
          iamCalls += 1;
          return [];
        },
      },
      enrollments: {
        getAccessGroup: async () => null,
        listAccessGroupProducts: async () => [],
        addAccessGroupMember: async () => ({}),
        findExistingEnrollment: async () => null,
        createEnrollment: async () => ({}),
      },
    });

    expect(iamCalls).toBe(0);
    expect(report.summary).toMatchObject({
      attemptedOperations: 1,
      succeededOperations: 0,
      failedOperations: 1,
      skippedBlockedRows: 2,
      progressWrites: 0,
    });
    expect(report.results[0]?.status).toBe("failed");
    expect(report.results[0]?.errorCode).toBe("ACCESS_GROUP_NOT_FOUND");
  });
});
