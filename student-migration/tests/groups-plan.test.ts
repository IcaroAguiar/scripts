import { describe, expect, test } from "bun:test";
import type { CatalogMap } from "../src/catalog-map";
import type { CourseListByType } from "../src/course-list";
import { buildGroupsPlan } from "../src/groups-plan";
import type { ProductAggregate } from "../src/layouts/themembers-products";

const catalogMap: CatalogMap = {
  tenantId: "tenant-1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  products: [
    { productId: "prod-alta", productTitle: "Alta Performance com Gustavo Borges", courseId: "course-alta", lessons: [] },
    { productId: "prod-bi", productTitle: "Fundamentos de Business Intelligence - MBA", courseId: "course-bi", lessons: [] },
  ],
};

const courseList: CourseListByType = {
  "tetra-club": {
    courses: ["Alta Performance com Gustavo Borges"],
    sections: ["Gestão & Liderança"],
    ignored: [],
  },
  pos: {
    courses: ["Alta Performance com Gustavo Borges", "Curso Inexistente"],
    sections: [],
    ignored: [],
  },
  mba: {
    courses: ["Fundamentos de Business Intelligence - MBA", "Alta Performance com Gustavo Borges"],
    sections: [],
    ignored: [],
  },
};

function product(overrides: Partial<ProductAggregate>): ProductAggregate {
  return {
    productId: "p",
    productName: "x",
    studentCount: 1,
    conflictingNames: [],
    ...overrides,
  };
}

describe("buildGroupsPlan", () => {
  const plan = buildGroupsPlan({
    tenantId: "tenant-1",
    environment: "dev",
    courseList,
    catalogMap,
    products: [
      product({ productId: "p1", productName: "MBA X + Tetra Club - 18 meses - as", studentCount: 10 }),
      product({ productId: "p2", productName: "MBA X + Tetra Club - 18 meses -p", studentCount: 5 }),
      product({ productId: "p3", productName: "Tetra Club - Acesso 4 anos", studentCount: 100 }),
      product({ productId: "p4", productName: "Formação Análise de Dados + Tetra Club", studentCount: 7 }),
      product({ productId: "p5", productName: "Formação Excel Expert - 2 anos", studentCount: 3 }),
      product({ productId: "p6", productName: "TETRA CLUB | 7 DIAS GRATUITO - VITALÍCIO", studentCount: 2 }),
      product({ productId: "p7", productName: "Ferramentas Tetra Club", studentCount: 16 }),
    ],
  });

  test("consolidates gateway variants into one group", () => {
    const mba = plan.groups.find((group) => group.type === "mba");
    expect(mba?.sourceProducts.map((source) => source.productId).sort()).toEqual(["p1", "p2"]);
    expect(mba?.totalStudents).toBe(15);
    expect(mba?.finalName).toBe("MBA X + Tetra Club - 18 meses - migracao");
    expect(mba?.periodicity).toBe("MONTHLY");
    expect(mba?.periodicityValue).toBe(18);
  });

  test("combo with tetra club is in scope; out-of-scope and excluded reported", () => {
    const combo = plan.groups.find((group) =>
      group.sourceProducts.some((source) => source.productId === "p4"),
    );
    expect(combo?.type).toBe("tetra-club");
    expect(combo?.finalName).toBe("Formação Análise de Dados + Tetra Club - migracao");
    expect(plan.ambiguousProducts).toEqual([]);
    expect(plan.outOfScopeProducts.map((entry) => entry.productId)).toEqual(["p5"]);
    expect(plan.excludedProducts.map((entry) => entry.productId)).toEqual(["p7"]);
  });

  test("pure tetra club canonicalizes name", () => {
    const tc = plan.groups.find((group) =>
      group.sourceProducts.some((source) => source.productId === "p3"),
    );
    expect(tc?.finalName).toBe("Tetra Club - Acesso 4 anos - migracao");
  });

  test("marks conflicting periodicity groups as ambiguous-periodicity", () => {
    const conflicting = plan.groups.find((group) =>
      group.sourceProducts.some((source) => source.productId === "p6"),
    );
    expect(conflicting?.status).toBe("ambiguous-periodicity");
  });

  test("resolves course titles against the catalog and flags unresolved", () => {
    const pos = courseList.pos;
    expect(pos.courses).toContain("Curso Inexistente");
    const mba = plan.groups.find((group) => group.type === "mba");
    expect(mba?.courses.map((course) => course.resolution)).toEqual(["resolved", "resolved"]);
    expect(plan.summary.unresolvedCourses).toBe(1);
  });

  test("summary counts add up", () => {
    expect(plan.summary.products).toBe(7);
    expect(plan.summary.inScopeProducts).toBe(5);
    expect(plan.summary.groups).toBe(4);
    expect(plan.summary.executableGroups).toBe(3);
    expect(plan.summary.excludedProducts).toBe(1);
  });

  test("lifetime group carries no periodicity fields", () => {
    const tc = plan.groups.find((group) =>
      group.sourceProducts.some((source) => source.productId === "p3"),
    );
    expect(tc?.periodicity).toBe("YEARLY");
    expect(tc?.periodicityValue).toBe(4);
  });

  test("no-mention group falls back to 100 years (decision 2026-07-07)", () => {
    const combo = plan.groups.find((group) =>
      group.sourceProducts.some((source) => source.productId === "p4"),
    );
    expect(combo?.periodicity).toBe("YEARLY");
    expect(combo?.periodicityValue).toBe(100);
    expect(combo?.status).toBe("ok");
  });
});
