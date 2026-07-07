import { describe, expect, test } from "bun:test";
import type { AccessGroupStore } from "../src/consumo-execute";
import {
  executeGroupsRun,
  type GroupsEnrollmentsClient,
  type GroupsExecutionClients,
} from "../src/groups-execute";
import type { GroupsRunPlan, PlannedGroup } from "../src/groups-plan";
import type { ProductGroupLink, ProductGroupStore } from "../src/ledger";
import { TetraApiError } from "../src/tetra-api";

function plannedGroup(overrides: Partial<PlannedGroup>): PlannedGroup {
  return {
    groupKey: "key",
    type: "tetra-club",
    finalName: "Tetra Club - Acesso 4 anos - migracao",
    periodicity: "YEARLY",
    periodicityValue: 4,
    status: "ok",
    totalStudents: 10,
    sourceProducts: [{ productId: "tm-1", rawName: "Tetra Club - Acesso 4 anos", studentCount: 10 }],
    courses: [
      { title: "Curso A", resolution: "resolved", productId: "prod-a", courseId: "course-a" },
      { title: "Curso B", resolution: "unresolved" },
    ],
    ...overrides,
  };
}

function buildPlan(groups: PlannedGroup[]): GroupsRunPlan {
  return {
    runId: "groups_test_1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    layout: "themembers-groups",
    tenantId: "tenant-1",
    environment: "dev",
    summary: {
      products: 0,
      inScopeProducts: 0,
      groups: groups.length,
      executableGroups: groups.filter((group) => group.status === "ok").length,
      ambiguousProducts: 0,
      excludedProducts: 0,
      outOfScopeProducts: 0,
      unresolvedCourses: 0,
    },
    courseList: {
      "tetra-club": { courses: [], sections: [], ignored: [] },
      pos: { courses: [], sections: [], ignored: [] },
      mba: { courses: [], sections: [], ignored: [] },
    },
    groups,
    ambiguousProducts: [],
    excludedProducts: [],
    outOfScopeProducts: [],
  };
}

type FakeState = {
  createdGroups: Array<{ name: string; periodicity?: string; periodicityValue?: number }>;
  attachedProducts: Map<string, Set<string>>;
  groupsById: Map<string, string>;
};

function fakeClients(state: FakeState): GroupsExecutionClients & {
  ledger: Map<string, string>;
  links: Array<{ tenantId: string; link: ProductGroupLink }>;
} {
  const ledger = new Map<string, string>();
  const links: Array<{ tenantId: string; link: ProductGroupLink }> = [];

  const enrollments: GroupsEnrollmentsClient = {
    async getAccessGroup(accessGroupId) {
      return state.groupsById.has(accessGroupId) ? { id: accessGroupId } : null;
    },
    async createAccessGroup(input) {
      const id = `group-${state.createdGroups.length + 1}`;
      state.createdGroups.push(input);
      state.groupsById.set(id, input.name);
      state.attachedProducts.set(id, new Set());
      return { id, name: input.name };
    },
    async listAccessGroupProducts(accessGroupId) {
      return Array.from(state.attachedProducts.get(accessGroupId) ?? []).map((productId) => ({
        productId,
      }));
    },
    async addAccessGroupProduct(input) {
      const attached = state.attachedProducts.get(input.accessGroupId);
      if (!attached) throw new TetraApiError("group not found", "HTTP_ERROR", 404);
      if (attached.has(input.productId)) {
        throw new TetraApiError("conflict", "HTTP_ERROR", 409);
      }
      attached.add(input.productId);
      return {};
    },
  };

  const accessGroupStore: AccessGroupStore = {
    findCreatedAccessGroup: (tenantId, name) => ledger.get(`${tenantId}:${name}`),
    recordCreatedAccessGroup: (tenantId, name, accessGroupId) => {
      ledger.set(`${tenantId}:${name}`, accessGroupId);
    },
  };

  const productGroupStore: ProductGroupStore = {
    recordProductGroupLink: (tenantId, link) => {
      links.push({ tenantId, link });
    },
    findProductGroupLink: () => undefined,
  };

  return { enrollments, accessGroupStore, productGroupStore, ledger, links };
}

function freshState(): FakeState {
  return { createdGroups: [], attachedProducts: new Map(), groupsById: new Map() };
}

describe("executeGroupsRun", () => {
  test("creates group with periodicity, attaches resolved courses, records links", async () => {
    const state = freshState();
    const clients = fakeClients(state);
    const report = await executeGroupsRun(buildPlan([plannedGroup({})]), clients);

    expect(report.summary.createdGroups).toBe(1);
    expect(state.createdGroups[0]).toEqual({
      name: "Tetra Club - Acesso 4 anos - migracao",
      periodicity: "YEARLY",
      periodicityValue: 4,
    });
    expect(report.results[0]?.productsAttached).toBe(1);
    expect(report.results[0]?.skippedCourses).toBe(1);
    expect(clients.links).toEqual([
      {
        tenantId: "tenant-1",
        link: {
          themembersProductId: "tm-1",
          themembersProductName: "Tetra Club - Acesso 4 anos",
          accessGroupId: "group-1",
          groupName: "Tetra Club - Acesso 4 anos - migracao",
        },
      },
    ]);
  });

  test("omits periodicity fields for lifetime groups", async () => {
    const state = freshState();
    const clients = fakeClients(state);
    const group = plannedGroup({});
    delete group.periodicity;
    delete group.periodicityValue;
    await executeGroupsRun(buildPlan([group]), clients);
    expect(state.createdGroups[0]).toEqual({ name: "Tetra Club - Acesso 4 anos - migracao" });
  });

  test("rerun reuses the group from ledger and does not duplicate products", async () => {
    const state = freshState();
    const clients = fakeClients(state);
    const plan = buildPlan([plannedGroup({})]);

    const first = await executeGroupsRun(plan, clients);
    const second = await executeGroupsRun(plan, clients);

    expect(first.summary.createdGroups).toBe(1);
    expect(second.summary.createdGroups).toBe(0);
    expect(second.summary.reusedGroups).toBe(1);
    expect(second.results[0]?.productsExisting).toBe(1);
    expect(second.results[0]?.productsAttached).toBe(0);
    expect(state.createdGroups).toHaveLength(1);
  });

  test("tolerates 409 conflicts when attaching products", async () => {
    const state = freshState();
    const clients = fakeClients(state);
    const original = clients.enrollments.listAccessGroupProducts.bind(clients.enrollments);
    // Simula corrida: o list nao ve o produto, mas o add responde 409.
    clients.enrollments.listAccessGroupProducts = async (accessGroupId) => {
      const items = await original(accessGroupId);
      const set = state.attachedProducts.get(accessGroupId);
      set?.add("prod-a");
      return items;
    };

    const report = await executeGroupsRun(buildPlan([plannedGroup({})]), clients);
    expect(report.results[0]?.productsExisting).toBe(1);
    expect(report.results[0]?.status).toBe("succeeded");
  });

  test("skips ambiguous-periodicity groups without touching the API", async () => {
    const state = freshState();
    const clients = fakeClients(state);
    const report = await executeGroupsRun(
      buildPlan([plannedGroup({ status: "ambiguous-periodicity" })]),
      clients,
    );

    expect(report.summary.skippedGroups).toBe(1);
    expect(state.createdGroups).toHaveLength(0);
    expect(clients.links).toHaveLength(0);
  });

  test("group create failure is reported and does not abort other groups", async () => {
    const state = freshState();
    const clients = fakeClients(state);
    const originalCreate = clients.enrollments.createAccessGroup.bind(clients.enrollments);
    let calls = 0;
    clients.enrollments.createAccessGroup = async (input) => {
      calls += 1;
      if (calls === 1) throw new TetraApiError("boom", "HTTP_ERROR", 500);
      return originalCreate(input);
    };

    const report = await executeGroupsRun(
      buildPlan([
        plannedGroup({ groupKey: "k1", finalName: "Grupo 1 - migracao" }),
        plannedGroup({ groupKey: "k2", finalName: "Grupo 2 - migracao" }),
      ]),
      clients,
    );

    expect(report.summary.failedGroups).toBe(1);
    expect(report.summary.createdGroups).toBe(1);
  });
});
