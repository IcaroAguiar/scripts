import { describe, expect, test } from "bun:test";
import { parseCourseList } from "../src/course-list";

// Recorte fiel da estrutura real de PRODUTOS_CURSOS: secoes numeradas cujos
// cursos reiniciam em "1.", duracoes irregulares, nao-cursos e repeticao do
// catalogo Tetra Club nas colunas Pos/MBA.
const MATRIX: string[][] = [
  ["Tetra Club", "Pós-Graduação", "MBA"],
  ["1. Gestão & Liderança", "Liderança Visionária e Estratégia de Futuro", "Documentos para matricula"],
  ["1. Alta Performance com Gustavo Borges — 2h", "Cultura Organizacional e Times de Alta Performance", "Fundamentos de Business Intelligence - MBA"],
  ["2. Gestão de Tempo e Produtividade — 4h", "Gravações - Aulas ao Vivo - Pós-Gestão", "Projeto Final MBA"],
  ["3. ClickUp para Gestores — 1h30", "Links Importantes - Pós Gestão", "Gravações - Aulas ao Vivo - MBA Business Intelligence & Analytics"],
  ["", "1. Gestão & Liderança", "1. Gestão & Liderança"],
  ["2. Análise de Dados", "1. Alta Performance com Gustavo Borges — 2h", "1. Alta Performance com Gustavo Borges — 2h"],
  ["1. Introdução à Análise de Dados — 6h", "2. Gestão de Tempo e Produtividade — 4h", "2. Gestão de Tempo e Produtividade — 4h"],
  ["2. Análise de Dados com Python", "3. ClickUp para Gestores — 1h30", "3. ClickUp para Gestores — 1h30"],
  ["3. Plano de Impulsionamento de Carreira — 50min", "", ""],
];

describe("parseCourseList", () => {
  const parsed = parseCourseList(MATRIX);

  test("detects sections by numbering restart, not by duration", () => {
    expect(parsed["tetra-club"].sections).toEqual(["Gestão & Liderança", "Análise de Dados"]);
    expect(parsed["tetra-club"].courses).toEqual([
      "Alta Performance com Gustavo Borges",
      "Gestão de Tempo e Produtividade",
      "ClickUp para Gestores",
      "Introdução à Análise de Dados",
      "Análise de Dados com Python",
      "Plano de Impulsionamento de Carreira",
    ]);
  });

  test("keeps unnumbered own courses and ignores non-courses", () => {
    expect(parsed.pos.courses).toContain("Liderança Visionária e Estratégia de Futuro");
    expect(parsed.pos.ignored).toEqual([
      "Gravações - Aulas ao Vivo - Pós-Gestão",
      "Links Importantes - Pós Gestão",
    ]);
    expect(parsed.mba.ignored).toContain("Documentos para matricula");
  });

  test("dedupes the repeated Tetra Club catalog inside Pos/MBA", () => {
    const count = parsed.pos.courses.filter(
      (course) => course === "Alta Performance com Gustavo Borges",
    ).length;
    expect(count).toBe(1);
  });

  test("mba keeps its own courses", () => {
    expect(parsed.mba.courses).toContain("Fundamentos de Business Intelligence - MBA");
    expect(parsed.mba.courses).toContain("Projeto Final MBA");
  });

  test("throws when a header column is missing", () => {
    expect(() => parseCourseList([["Tetra Club", "MBA"]])).toThrow(/pos/);
  });
});
