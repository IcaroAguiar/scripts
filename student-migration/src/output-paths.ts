import { basename, extname, join } from "node:path";
import { normalizeLocalPathInput } from "./path-utils";

export type MigrationOutputPaths = {
  output: string;
  ledger: string;
  executeReport: string;
};

export function deriveMigrationOutputPaths(inputPath: string): MigrationOutputPaths {
  const normalizedInput = normalizeLocalPathInput(inputPath);
  const extension = extname(normalizedInput);
  const rawName = basename(normalizedInput, extension);
  const slug = slugifyFileStem(rawName) || "migration";

  return {
    output: join("storage", `${slug}-plan.json`),
    ledger: join("storage", `${slug}-runs.sqlite`),
    executeReport: join("storage", `${slug}-execute.json`),
  };
}

function slugifyFileStem(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
