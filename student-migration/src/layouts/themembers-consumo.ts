import type { SourceRow } from "../migration-plan";
import { isValidEmail, normalizeEmail, normalizeText, toSourceRef } from "../migration-plan";
import type { SourceRef } from "../migration-plan";
import { parseSaoPauloDate } from "../period";

export const THEMEMBERS_CONSUMO_LAYOUT = "themembers-consumo" as const;

// Cabecalhos do export de consumo da TheMembers (uma linha por aluno+aula).
export const CONSUMO_REQUIRED_HEADERS = [
  "student_email",
  "student_name",
  "course_title",
  "lesson_title",
  "finished",
] as const;

export const CONSUMO_OPTIONAL_HEADERS = [
  "module_title",
  "finished_at",
  "student_phone",
] as const;

export type ConsumoRow = {
  sourceRef: SourceRef;
  email: string;
  name: string;
  phone?: string;
  courseTitle: string;
  moduleTitle: string;
  lessonTitle: string;
  finished: boolean;
  /** ISO UTC derivado de finished_at (America/Sao_Paulo) quando finished=1. */
  finishedAtIso?: string;
  issues: string[];
};

export function detectConsumoLayout(headers: string[]): boolean {
  const set = new Set(headers.map((header) => header.trim().toLowerCase()));
  return CONSUMO_REQUIRED_HEADERS.every((header) => set.has(header));
}

export function assertConsumoHeaders(headers: string[]): void {
  const set = new Set(headers.map((header) => header.trim().toLowerCase()));
  const missing = CONSUMO_REQUIRED_HEADERS.filter((header) => !set.has(header));
  if (missing.length > 0) {
    throw new Error(
      `spreadsheet does not match the themembers-consumo layout; missing headers: ${missing.join(", ")}`,
    );
  }
}

export function parseConsumoRows(rows: SourceRow[]): ConsumoRow[] {
  return rows.map((row) => parseConsumoRow(row));
}

function parseConsumoRow(row: SourceRow): ConsumoRow {
  const issues: string[] = [];
  const email = normalizeEmail(readValue(row, "student_email"));
  const name = normalizeText(readValue(row, "student_name"));
  const phone = normalizeText(readValue(row, "student_phone"));
  const courseTitle = normalizeText(readValue(row, "course_title"));
  const moduleTitle = normalizeText(readValue(row, "module_title"));
  const lessonTitle = normalizeText(readValue(row, "lesson_title"));
  const finishedRaw = normalizeText(readValue(row, "finished"));
  const finishedAtRaw = normalizeText(readValue(row, "finished_at"));

  if (!email) {
    issues.push("email is required");
  } else if (!isValidEmail(email)) {
    issues.push("email is invalid");
  }

  if (!courseTitle) {
    issues.push("course_title is required");
  }
  if (!lessonTitle) {
    issues.push("lesson_title is required");
  }

  let finished = false;
  if (finishedRaw === "1") {
    finished = true;
  } else if (finishedRaw !== "0" && finishedRaw !== "") {
    issues.push(`finished must be 0 or 1, got "${finishedRaw}"`);
  }

  let finishedAtIso: string | undefined;
  if (finished) {
    const parsed = finishedAtRaw ? parseSaoPauloDate(finishedAtRaw) : undefined;
    if (!parsed) {
      issues.push("finished=1 requires a valid finished_at date");
    } else {
      finishedAtIso = parsed.toISOString();
    }
  }

  return {
    sourceRef: toSourceRef(row),
    email,
    name,
    ...(phone ? { phone } : {}),
    courseTitle,
    moduleTitle,
    lessonTitle,
    finished,
    ...(finishedAtIso ? { finishedAtIso } : {}),
    issues,
  };
}

function readValue(row: SourceRow, header: string): string {
  if (header in row.values) {
    return row.values[header] ?? "";
  }

  // Tolerancia a variacao de caixa nos cabecalhos exportados.
  const target = header.toLowerCase();
  for (const [key, value] of Object.entries(row.values)) {
    if (key.trim().toLowerCase() === target) {
      return value ?? "";
    }
  }

  return "";
}
