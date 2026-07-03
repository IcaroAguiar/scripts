import type { MigrationCliOptions } from "./run-migration";
import { normalizeLocalPathInput } from "./path-utils";
import { deriveMigrationOutputPaths } from "./output-paths";

export type InteractiveMode = "dry-run" | "execute-fake" | "execute-dev";

export type InteractiveAnswers = {
  input: string;
  profile: string;
  mode: InteractiveMode;
  output?: string;
  ledger?: string;
  executeReport?: string;
  envFile?: string;
  /** Perfis v2 (themembers-consumo): overrides digitados na TUI. */
  startsAt?: string;
  periodicity?: "DAILY" | "MONTHLY" | "YEARLY";
  periodicityValue?: string;
  syncCatalog?: boolean;
};

export function buildInteractiveOptions(answers: InteractiveAnswers): MigrationCliOptions {
  const execute = answers.mode === "execute-fake" || answers.mode === "execute-dev";
  const adapter = answers.mode === "execute-dev" ? "tetra-dev" : "fake";
  const input = normalizeLocalPathInput(answers.input);
  const derivedPaths = deriveMigrationOutputPaths(input);
  const periodicityValue = answers.periodicityValue
    ? Number.parseInt(answers.periodicityValue, 10)
    : undefined;

  const consumoOverrides = {
    ...(answers.startsAt ? { accessStartsAt: answers.startsAt } : {}),
    ...(answers.periodicity ? { periodicity: answers.periodicity } : {}),
    ...(periodicityValue && Number.isInteger(periodicityValue) && periodicityValue > 0
      ? { periodicityValue }
      : {}),
  };

  return {
    input,
    profile: normalizeLocalPathInput(answers.profile),
    output: normalizeLocalPathInput(answers.output || derivedPaths.output),
    execute,
    ...(answers.mode === "execute-dev" ? { preflightDev: true } : {}),
    ...(execute ? { adapter } : {}),
    ...(answers.mode === "execute-dev" ? { allowDevExecute: true } : {}),
    ...(answers.mode === "execute-dev" && answers.envFile
      ? { envFile: normalizeLocalPathInput(answers.envFile) }
      : {}),
    ...(answers.syncCatalog ? { syncCatalog: true } : {}),
    ...(Object.keys(consumoOverrides).length > 0 ? { consumoOverrides } : {}),
    ledger: normalizeLocalPathInput(answers.ledger || derivedPaths.ledger),
    executeReport: normalizeLocalPathInput(
      answers.executeReport || derivedPaths.executeReport,
    ),
  };
}
