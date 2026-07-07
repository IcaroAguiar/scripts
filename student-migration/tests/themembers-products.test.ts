import { describe, expect, test } from "bun:test";
import {
  parseTheMembersProducts,
  readTheMembersProductsFile,
  reconstructLine,
} from "../src/layouts/themembers-products";

describe("reconstructLine", () => {
  test("unwraps outer quotes and drops trailing empty cells", () => {
    expect(reconstructLine('"a;""b"";""c""",,,')).toBe('a;"b";"c"');
  });

  test("rejoins product names broken across cells by embedded commas", () => {
    expect(reconstructLine('"x;""GESTÃO"," NEGÓCIOS E IA"";""y""",,,')).toBe(
      'x;"GESTÃO, NEGÓCIOS E IA";"y"',
    );
  });

  test("keeps plain header line intact", () => {
    expect(reconstructLine("user_id;user_name,,,")).toBe("user_id;user_name");
  });
});

describe("parseTheMembersProducts", () => {
  const header =
    "user_id;user_name;user_email;document;phone;product_id;product_name;user_subscription_created_at,,,";

  test("parses rows and aggregates products by id", () => {
    const text = [
      header,
      '"u1;""Ana"";""ana@example.com"";"""";"""";""p1"";""Tetra Club - Acesso 4 anos"";""2024-01-01 00:00:00""",,,',
      '"u2;""Bia"";""bia@example.com"";"""";"""";""p1"";""Tetra Club - Acesso 4 anos"";""2024-01-02 00:00:00""",,,',
      '"u3;""Caio"";""caio@example.com"";"""";"""";""p2"";""MBA X - 18 meses"";""2024-01-03 00:00:00""",,,',
    ].join("\n");

    const result = parseTheMembersProducts(text);
    expect(result.rows).toHaveLength(3);
    expect(result.skippedLines).toHaveLength(0);
    expect(result.products).toHaveLength(2);
    expect(result.products[0]).toMatchObject({
      productId: "p1",
      productName: "Tetra Club - Acesso 4 anos",
      studentCount: 2,
      conflictingNames: [],
    });
  });

  test("reports name conflicts for the same product id", () => {
    const text = [
      header,
      '"u1;""Ana"";""ana@example.com"";"""";"""";""p1"";""Nome A"";""2024-01-01 00:00:00""",,,',
      '"u2;""Bia"";""bia@example.com"";"""";"""";""p1"";""Nome B"";""2024-01-02 00:00:00""",,,',
    ].join("\n");

    const result = parseTheMembersProducts(text);
    expect(result.products[0]?.conflictingNames).toEqual(["Nome B"]);
  });

  test("skips malformed lines with a reason", () => {
    const text = [header, '"so;dois-campos",,,'].join("\n");
    const result = parseTheMembersProducts(text);
    expect(result.rows).toHaveLength(0);
    expect(result.skippedLines).toHaveLength(1);
    expect(result.skippedLines[0]?.lineNumber).toBe(2);
  });

  test("rejects unexpected header", () => {
    expect(() => parseTheMembersProducts("foo;bar")).toThrow(/Unexpected TheMembers/);
  });
});

describe("readTheMembersProductsFile", () => {
  test("reads the cp1252 fixture, fixing encoding and broken commas", async () => {
    const result = await readTheMembersProductsFile("fixtures/themembers-products.csv");
    expect(result.encoding).toBe("windows-1252");
    expect(result.rows).toHaveLength(4);
    expect(result.skippedLines).toHaveLength(0);

    const names = result.products.map((product) => product.productName);
    expect(names).toContain("PÓS-GRADUAÇÃO GESTÃO, NÉGÓCIOS E IA + Tetra Club 10 - a");
    expect(names).toContain("MBA em BI e Analytics + Tetra Club - 18 meses - as");

    const mba = result.products.find((product) => product.productId === "prod-1");
    expect(mba?.studentCount).toBe(2);
  });
});
