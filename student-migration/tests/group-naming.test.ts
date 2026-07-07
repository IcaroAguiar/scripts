import { describe, expect, test } from "bun:test";
import {
  canonicalTetraClubName,
  classifyProduct,
  groupKeyForName,
  normalizeGroupName,
  parsePeriodicityFromName,
} from "../src/group-naming";

describe("normalizeGroupName", () => {
  test("removes gateway suffix and appends migration suffix", () => {
    expect(
      normalizeGroupName("MBA em Business Intelligence e Analytics + Tetra Club - 18 meses - as"),
    ).toBe("MBA em Business Intelligence e Analytics + Tetra Club - 18 meses - migracao");
  });

  test("removes CNPJ, leading dash and normalizes spaces", () => {
    expect(
      normalizeGroupName("- Tetra Club com acesso estendido para 4 anos - CNPJ 34.285.904/0001-22"),
    ).toBe("Tetra Club com acesso estendido para 4 anos - migracao");
  });

  test("removes compact CNPJ form", () => {
    expect(
      normalizeGroupName("Oferta Especial Excel + Power bi - CNPJ: 342859040001-22"),
    ).toBe("Oferta Especial Excel + Power bi - migracao");
  });

  test("removes installment residue after CNPJ", () => {
    expect(
      normalizeGroupName(
        "- Tetra Club com acesso VITALÍCIO - Parcelado 18X 165,00 CNPJ 34.285.904/0001-22",
      ),
    ).toBe("Tetra Club com acesso VITALÍCIO - migracao");
  });

  test("strips existing migration token to avoid double suffix", () => {
    expect(normalizeGroupName("Tetra Club - Migração")).toBe("Tetra Club - migracao");
    expect(normalizeGroupName("Formação Excel Expert (3 Anos) - (Migração)")).toBe(
      "Formação Excel Expert (3 Anos) - migracao",
    );
  });

  test("strips leading channel prefix", () => {
    expect(
      normalizeGroupName("on - tetra club com acesso estendido para 10 anos - cnpj 34.285.904/0001-22"),
    ).toBe("Tetra Club com acesso estendido para 10 anos - migracao");
  });

  test("strips gateway suffix after closing bracket", () => {
    expect(
      groupKeyForName(
        "FORMAÇÃO EM GESTÃO DE PESSOAS, GESTÃO DE NEGÓCIOS & IA + TETRA CLUB - [Extensão Universitária] on",
      ),
    ).toBe(
      groupKeyForName(
        "FORMAÇÃO EM GESTÃO DE PESSOAS, GESTÃO DE NEGÓCIOS & IA + TETRA CLUB - [Extensão Universitária]",
      ),
    );
  });

  test("keeps names without noise intact", () => {
    expect(normalizeGroupName("Tetra Club - Acesso 4 anos")).toBe(
      "Tetra Club - Acesso 4 anos - migracao",
    );
  });
});

describe("groupKeyForName", () => {
  test("consolidates gateway variants into one key", () => {
    const a = groupKeyForName("MBA em Business Intelligence e Analytics + Tetra Club - 18 meses - as");
    const b = groupKeyForName("MBA em Business Intelligence e Analytics + Tetra Club - 18 meses -p");
    expect(a).toBe(b);
  });

  test("consolidates case-insensitive duplicates", () => {
    expect(groupKeyForName("Tetra Club - Acesso 4 anos")).toBe(
      groupKeyForName("TETRA CLUB - ACESSO 4 ANOS"),
    );
  });

  test("does not consolidate different periodicities", () => {
    expect(groupKeyForName("Tetra Club - Acesso 4 anos")).not.toBe(
      groupKeyForName("Tetra Club - Acesso 1 ano"),
    );
  });
});

describe("decisions 2026-07-07", () => {
  test("TetraClub and Tetra Club consolidate into one group", () => {
    expect(
      groupKeyForName("MBA em Business Intelligence e Analytics + TetraClub - 18 meses -p"),
    ).toBe(groupKeyForName("MBA em Business Intelligence e Analytics + Tetra Club - 18 meses - as"));
  });

  test("pos variants differing by comma/typo/bare-10 consolidate", () => {
    const a = groupKeyForName("PÓS-GRADUAÇÃO GESTÃO NEGÓCIOS E IA + Tetra Club 10 - m");
    const b = groupKeyForName("PÓS-GRADUAÇÃO GESTÃO, NÉGÓCIOS E IA + Tetra Club 10 - a");
    const c = groupKeyForName("PÓS-GRADUAÇÃO GESTÃO NEGÓCIOS E IA + Tetra Club 10 anos - ");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test("sem 10 anos override yields 18 months", () => {
    expect(parsePeriodicityFromName("PÓS-GRADUAÇÃO GESTÃO NEGÓCIOS E IA - sem 10 anos")).toEqual({
      status: "parsed",
      value: { periodicity: "MONTHLY", periodicityValue: 18 },
    });
  });
});

describe("canonicalTetraClubName", () => {
  test("formatting variants of pure Tetra Club collapse to one canonical name", () => {
    const expected = "Tetra Club - Acesso 4 anos - migracao";
    expect(canonicalTetraClubName("Tetra Club - Acesso 4 anos")).toBe(expected);
    expect(canonicalTetraClubName("TETRA CLUB COM ACESSO DE 4 ANOS")).toBe(expected);
    expect(
      canonicalTetraClubName("- Tetra Club com acesso estendido para 4 anos - CNPJ 34.285.904/0001-22"),
    ).toBe(expected);
    expect(canonicalTetraClubName("Tetra Club 4 Anos - Eduzz")).toBe(expected);
  });

  test("lifetime and plain variants get canonical names too", () => {
    expect(canonicalTetraClubName("- Tetra Club com acesso VITALÍCIO -")).toBe(
      "Tetra Club - Acesso Vitalício - migracao",
    );
    expect(canonicalTetraClubName("Tetra Club - Migração")).toBe("Tetra Club - migracao");
  });

  test("real qualifiers keep the group separate", () => {
    expect(canonicalTetraClubName("Tetra Club Liderança - Acesso de 1 ano")).toBeUndefined();
    expect(canonicalTetraClubName("Tetra Club Corporativo")).toBeUndefined();
    expect(canonicalTetraClubName("Tetra Club - Trial 7 Dias")).toBeUndefined();
    expect(canonicalTetraClubName("TETRA CLUB 12 MESES - BÔNUS")).toBeUndefined();
    expect(
      canonicalTetraClubName("-Tetra Club - Acesso 2 anos- Recorrente - CNPJ: 34.285.904/0001-22"),
    ).toBeUndefined();
    expect(canonicalTetraClubName("Tetra Club Anual | Perpétuo")).toBeUndefined();
  });
});

describe("parsePeriodicityFromName", () => {
  test("parses months", () => {
    expect(parsePeriodicityFromName("MBA X - 18 meses")).toEqual({
      status: "parsed",
      value: { periodicity: "MONTHLY", periodicityValue: 18 },
    });
  });

  test("parses years", () => {
    expect(parsePeriodicityFromName("Tetra Club - Acesso 4 anos")).toEqual({
      status: "parsed",
      value: { periodicity: "YEARLY", periodicityValue: 4 },
    });
  });

  test("parses singular year", () => {
    expect(parsePeriodicityFromName("Tetra Club - Acesso 1 ano")).toEqual({
      status: "parsed",
      value: { periodicity: "YEARLY", periodicityValue: 1 },
    });
  });

  test("parses days", () => {
    expect(parsePeriodicityFromName("Tetra Club - Trial 7 Dias")).toEqual({
      status: "parsed",
      value: { periodicity: "DAILY", periodicityValue: 7 },
    });
  });

  test("maps anual to yearly 1", () => {
    expect(parsePeriodicityFromName("FORMAÇÕES TETRA EDUCAÇÃO - ACESSO ANUAL")).toEqual({
      status: "parsed",
      value: { periodicity: "YEARLY", periodicityValue: 1 },
    });
  });

  test("bare number after Tetra Club means years (decision 2026-07-07)", () => {
    expect(parsePeriodicityFromName("PÓS-GRADUAÇÃO GESTÃO NEGÓCIOS E IA + Tetra Club 10 - m")).toEqual({
      status: "parsed",
      value: { periodicity: "YEARLY", periodicityValue: 10 },
    });
    // Unidade explicita continua ganhando do numero solto.
    expect(parsePeriodicityFromName("TETRA CLUB 12 MESES - BÔNUS")).toEqual({
      status: "parsed",
      value: { periodicity: "MONTHLY", periodicityValue: 12 },
    });
  });

  test("lifetime has no periodicity", () => {
    expect(parsePeriodicityFromName("- Tetra Club com acesso VITALÍCIO -")).toEqual({
      status: "lifetime",
    });
  });

  test("no mention means none", () => {
    expect(parsePeriodicityFromName("Tetra Club Corporativo")).toEqual({ status: "none" });
  });

  test("lifetime plus duration is conflicting", () => {
    const result = parsePeriodicityFromName("TETRA CLUB | 7 DIAS GRATUITO - VITALÍCIO");
    expect(result.status).toBe("conflicting");
  });

  test("installment 18X is not read as periodicity", () => {
    // "Parcelado 18X 165,00" nao contem unidade de tempo.
    expect(
      parsePeriodicityFromName("Tetra Club com acesso VITALÍCIO - Parcelado 18X 165,00"),
    ).toEqual({ status: "lifetime" });
  });
});

describe("classifyProduct", () => {
  test("mba combos classify as mba", () => {
    expect(
      classifyProduct("MBA em Business Intelligence e Analytics + Tetra Club - 18 meses - as"),
    ).toEqual({ status: "in-scope", type: "mba" });
  });

  test("pos classifies as pos", () => {
    expect(classifyProduct("PÓS-GRADUAÇÃO GESTÃO NEGÓCIOS E IA + Tetra Club 10 - m")).toEqual({
      status: "in-scope",
      type: "pos",
    });
  });

  test("plain tetra club classifies as tetra-club", () => {
    expect(classifyProduct("Tetra Club - Acesso 4 anos")).toEqual({
      status: "in-scope",
      type: "tetra-club",
    });
  });

  test("combos with tetra club unlock the tetra club column (decision 2026-07-07)", () => {
    expect(classifyProduct("Formação Análise de Dados + Tetra Club")).toEqual({
      status: "in-scope",
      type: "tetra-club",
    });
    expect(classifyProduct("Carreira Executiva + Tetra Club 2 Anos")).toEqual({
      status: "in-scope",
      type: "tetra-club",
    });
  });

  test("taxa and ferramentas are excluded (decision 2026-07-07)", () => {
    expect(
      classifyProduct("Taxa de Matrícula - Pós-Graduação em Gestão, Negócios e IA").status,
    ).toBe("excluded");
    expect(classifyProduct("Ferramentas Tetra Club").status).toBe("excluded");
  });

  test("unrelated products are out of scope", () => {
    expect(classifyProduct("Formação Excel Expert (3 Anos) - (Migração)")).toEqual({
      status: "out-of-scope",
    });
    expect(classifyProduct("MasterClass Inteligência Artificial")).toEqual({
      status: "out-of-scope",
    });
  });
});
