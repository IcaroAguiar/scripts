// CLI do modo "grupos de migracao" (--groups). Mantido fora do index para nao
// inflar o parser principal, que e centrado em planilhas de membros.

import type { GroupsEnvironment } from "./groups-plan";
import { runGroupsMigration, type GroupsCliOptions } from "./run-groups";

export async function runGroupsCli(args: string[]): Promise<void> {
  const options = parseGroupsArgs(args);
  const result = await runGroupsMigration(options);

  const { summary } = result.plan;
  console.log(`run: ${result.plan.runId}`);
  console.log(`themembers products: ${summary.products} (skipped lines: ${result.skippedLines})`);
  console.log(`in-scope products: ${summary.inScopeProducts} -> groups: ${summary.groups}`);
  console.log(`executable groups: ${summary.executableGroups}`);
  console.log(`ambiguous products: ${summary.ambiguousProducts}`);
  console.log(`excluded products: ${summary.excludedProducts}`);
  console.log(`out-of-scope products: ${summary.outOfScopeProducts}`);
  console.log(`unresolved course titles: ${summary.unresolvedCourses}`);
  console.log(`plan: ${result.planPath}`);
  console.log(`review csv: ${result.reviewCsvPath}`);
  console.log(`ambiguous csv: ${result.ambiguousCsvPath}`);
  console.log(`apply csv: ${result.applyCsvPath}`);

  if (result.executeReport) {
    const report = result.executeReport.summary;
    console.log(`execute adapter: ${result.executeReport.adapter}`);
    console.log(
      `groups executed: ${report.executedGroups} (created: ${report.createdGroups}, reused: ${report.reusedGroups}, failed: ${report.failedGroups}, skipped: ${report.skippedGroups})`,
    );
    console.log(
      `products attached: ${report.productsAttached} (existing: ${report.productsExisting}, failed: ${report.productsFailed})`,
    );
    console.log(`product links recorded: ${report.productLinksRecorded}`);
    console.log(`execute report: ${result.executeReportPath}`);
  }
}

function parseGroupsArgs(args: string[]): GroupsCliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  const valueArgs = new Set([
    "--products-csv",
    "--courses-xlsx",
    "--tenant",
    "--environment",
    "--catalog-map",
    "--adapter",
    "--approval",
    "--env-file",
    "--output",
    "--review-csv",
    "--execute-report",
    "--ledger",
  ]);
  const flagArgs = new Set(["--groups", "--sync-catalog", "--execute", "--allow-dev-execute"]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      printGroupsHelp();
      process.exit(0);
    }
    if (flagArgs.has(arg)) {
      flags.add(arg);
      continue;
    }
    if (valueArgs.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}.`);
      }
      values.set(arg, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const productsCsv = values.get("--products-csv");
  const coursesXlsx = values.get("--courses-xlsx");
  const tenantId = values.get("--tenant");
  const environment = values.get("--environment");
  if (!productsCsv) throw new Error("Missing required --products-csv <file.csv> argument.");
  if (!coursesXlsx) throw new Error("Missing required --courses-xlsx <file.xlsx> argument.");
  if (!tenantId) throw new Error("Missing required --tenant <tenant-id> argument.");
  if (!isEnvironment(environment)) {
    throw new Error("Missing or invalid --environment. Use local, dev or production.");
  }

  const optional = (key: string, name: keyof GroupsCliOptions) => {
    const value = values.get(key);
    return value === undefined ? {} : { [name]: value };
  };

  return {
    productsCsv,
    coursesXlsx,
    tenantId,
    environment,
    ...optional("--catalog-map", "catalogMap"),
    ...optional("--adapter", "adapter"),
    ...optional("--approval", "approval"),
    ...optional("--env-file", "envFile"),
    ...optional("--output", "output"),
    ...optional("--review-csv", "reviewCsv"),
    ...optional("--execute-report", "executeReport"),
    ...optional("--ledger", "ledger"),
    syncCatalog: flags.has("--sync-catalog"),
    execute: flags.has("--execute"),
    allowDevExecute: flags.has("--allow-dev-execute"),
  };
}

function isEnvironment(value: string | undefined): value is GroupsEnvironment {
  return value === "local" || value === "dev" || value === "production";
}

function printGroupsHelp(): void {
  console.log(`Usage:
  bun run migrate -- --groups \\
    --products-csv ./storage/alunos.csv \\
    --courses-xlsx ./storage/produtos-cursos.xlsx \\
    --tenant <tenant-id> --environment dev \\
    [--catalog-map ./storage/catalog-map.json] [--sync-catalog] \\
    [--execute --adapter fake|tetra-dev --allow-dev-execute] \\
    [--approval ./storage/approval.json] [--env-file ./storage/tetra-dev.env]

Cria grupos de acesso de migracao a partir dos produtos TheMembers e vincula
os cursos do xlsx (colunas Tetra Club / Pos-Graduacao / MBA). Sem --execute,
gera apenas o plano JSON + CSV de revisao em storage/.
`);
}
