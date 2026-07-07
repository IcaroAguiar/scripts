// Parser da planilha PRODUTOS_CURSOS: 3 colunas (Tetra Club, Pos-Graduacao,
// MBA), cada uma listando os cursos que o grupo daquele tipo deve conter.
// As colunas misturam cabecalhos de secao, cursos numerados com duracao e
// entradas nao-curso; Pos e MBA repetem o catalogo do Tetra Club no final.

import type { GroupType } from "./group-naming";
import { stripDiacritics } from "./group-naming";

export type CourseColumn = {
  courses: string[];
  sections: string[];
  ignored: string[];
};

export type CourseListByType = Record<GroupType, CourseColumn>;

const EXPECTED_HEADERS: Array<{ type: GroupType; header: RegExp }> = [
  { type: "tetra-club", header: /^tetra club$/i },
  { type: "pos", header: /^pos-?graduacao$/i },
  { type: "mba", header: /^mba$/i },
];

const NON_COURSE_PATTERNS = [
  /^documentos para matricula/i,
  /^gravacoes - aulas ao vivo/i,
  /^links importantes/i,
];

const NUMBERED_PATTERN = /^(\d+)\.\s*(.+)$/;
const DURATION_SUFFIX_PATTERN = /\s*—\s*\d+\s*(h(\d+)?|min).*$/i;

export function parseCourseList(matrix: string[][]): CourseListByType {
  const headerRow = matrix[0] ?? [];
  const columns: Array<{ type: GroupType; index: number }> = [];

  for (const { type, header } of EXPECTED_HEADERS) {
    const index = headerRow.findIndex((cell) => header.test(comparable(cell)));
    if (index === -1) {
      throw new Error(`Course list is missing the "${type}" header column.`);
    }
    columns.push({ type, index });
  }

  const result = {} as CourseListByType;
  for (const { type, index } of columns) {
    const entries = matrix
      .slice(1)
      .map((row) => (row[index] ?? "").replace(/\s+/g, " ").trim())
      .filter((value) => value.length > 0);
    result[type] = parseColumn(entries);
  }

  return result;
}

function parseColumn(entries: string[]): CourseColumn {
  const courses: string[] = [];
  const sections: string[] = [];
  const ignored: string[] = [];
  const seenCourses = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const bare = stripNumbering(entry);

    if (NON_COURSE_PATTERNS.some((pattern) => pattern.test(comparable(bare)))) {
      ignored.push(entry);
      continue;
    }

    if (isSectionHeader(entries, index)) {
      sections.push(bare);
      continue;
    }

    const title = stripDuration(bare);
    const key = comparable(title);
    if (!seenCourses.has(key)) {
      seenCourses.add(key);
      courses.push(title);
    }
  }

  return { courses, sections, ignored };
}

/**
 * Um item numerado e cabecalho de secao quando o proximo item numerado da
 * coluna reinicia a contagem em "1." (os cursos sao numerados por secao).
 */
function isSectionHeader(entries: string[], index: number): boolean {
  const match = entries[index]!.match(NUMBERED_PATTERN);
  if (!match) {
    return false;
  }

  for (let next = index + 1; next < entries.length; next += 1) {
    const nextMatch = entries[next]!.match(NUMBERED_PATTERN);
    if (nextMatch) {
      return nextMatch[1] === "1";
    }
  }

  return false;
}

function stripNumbering(value: string): string {
  const match = value.match(NUMBERED_PATTERN);
  return match ? match[2]!.trim() : value;
}

function stripDuration(value: string): string {
  return value.replace(DURATION_SUFFIX_PATTERN, "").trim();
}

function comparable(value: string): string {
  return stripDiacritics(value).toLowerCase().replace(/\s+/g, " ").trim();
}
