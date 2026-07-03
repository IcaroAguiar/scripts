import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccessGroupChoice, MappingProfileV2 } from "./consumo-plan";
import type { MappingProfile } from "./migration-plan";
import type { AccessGroupPeriodicity } from "./period";

export type ProfileBuilderAnswers = {
  name: string;
  tenantId: string;
  environment: MappingProfile["environment"];
  groupMode: "create" | "existing";
  groupName?: string;
  groupId?: string;
  accessStartsAt: string;
  periodicity: AccessGroupPeriodicity;
  periodicityValue: number;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function validateTenantId(value: string): string | undefined {
  if (!value.trim()) return "Informe o identificador do tenant (ex.: tenant_local_tetra).";
  if (/\s/.test(value.trim())) return "O tenant nao pode conter espacos.";
  return undefined;
}

export function validateGroupName(value: string): string | undefined {
  if (!value.trim()) return "Informe o nome do grupo de acesso (ex.: Migracao Periodo 2).";
  if (value.trim().length > 120) return "Nome do grupo deve ter no maximo 120 caracteres.";
  return undefined;
}

export function validateGroupId(value: string): string | undefined {
  if (!value.trim()) return "Informe o id do grupo de acesso existente.";
  if (/\s/.test(value.trim())) return "O id do grupo nao pode conter espacos.";
  return undefined;
}

export function validateStartDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (!DATE_PATTERN.test(trimmed)) {
    return "Use o formato YYYY-MM-DD (ex.: 2026-01-15).";
  }
  const parsed = new Date(`${trimmed}T00:00:00-03:00`);
  if (Number.isNaN(parsed.getTime())) {
    return "Data invalida. Confira dia e mes.";
  }
  return undefined;
}

export function validatePeriodicityValue(value: string): string | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return "Informe um numero inteiro maior que zero (ex.: 1).";
  }
  return undefined;
}

export function buildProfileV2(answers: ProfileBuilderAnswers): MappingProfileV2 {
  const accessGroup: AccessGroupChoice =
    answers.groupMode === "existing"
      ? { mode: "existing", id: (answers.groupId ?? "").trim() }
      : {
          mode: "create",
          name: (answers.groupName ?? "").trim(),
          periodicity: answers.periodicity,
          periodicityValue: answers.periodicityValue,
        };

  return {
    version: 2,
    layout: "themembers-consumo",
    name: answers.name.trim(),
    tenantId: answers.tenantId.trim(),
    environment: answers.environment,
    accessGroup,
    enrollmentWindow: {
      accessStartsAt: answers.accessStartsAt.trim(),
      periodicity: answers.periodicity,
      periodicityValue: answers.periodicityValue,
    },
    catalogMapPath: `./catalog-map.${slugify(answers.tenantId)}.json`,
  };
}

export function deriveProfileFileName(baseLabel: string): string {
  return `profile.${slugify(baseLabel) || "migracao"}.json`;
}

/**
 * Grava o perfil em storage/ (gitignorado) sem sobrescrever arquivos
 * existentes: adiciona sufixo -2, -3... quando o nome ja esta em uso.
 */
export async function writeProfileFile(
  storageDir: string,
  baseLabel: string,
  profile: MappingProfileV2,
): Promise<string> {
  await mkdir(storageDir, { recursive: true });
  const baseName = deriveProfileFileName(baseLabel);

  let candidate = join(storageDir, baseName);
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = join(storageDir, baseName.replace(/\.json$/, `-${suffix}.json`));
    suffix += 1;
  }

  await mkdir(dirname(candidate), { recursive: true });
  await writeFile(candidate, `${JSON.stringify(profile, null, 2)}\n`);
  return candidate;
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
