import { runMigration, type MigrationCliOptions } from "./run-migration";
import { deriveMigrationOutputPaths } from "./output-paths";

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));

  if (options.interactive) {
    const { runInteractiveMigration } = await import("./interactive");
    await runInteractiveMigration();
    return;
  }

  const result = await runMigration(finalizeCliOptions(options));
  if (result.preflightSummary) {
    console.log("tetra-dev preflight: ok");
    console.log(`preflight checked operations: ${result.preflightSummary.checkedOperations}`);
    console.log(`preflight ready operations: ${result.preflightSummary.readyOperations}`);
    console.log(`preflight failed operations: ${result.preflightSummary.failedOperations}`);
    console.log(`preflight blocked rows: ${result.preflightSummary.blockedRows}`);
  }
  if (result.executeSummary) {
    console.log(`execute adapter: ${result.executeSummary.adapter}`);
    console.log(`execute attempted operations: ${result.executeSummary.attemptedOperations}`);
    console.log(`execute succeeded operations: ${result.executeSummary.succeededOperations}`);
    console.log(`execute blocked rows skipped: ${result.executeSummary.skippedBlockedRows}`);
    console.log(`execute report: ${result.executeReportPath}`);
  }
  if (result.consumoPreflightReport) {
    const { summary, checks } = result.consumoPreflightReport;
    console.log(
      `consumo preflight: ok=${summary.ok} warnings=${summary.warnings} failures=${summary.failures}`,
    );
    for (const check of checks) {
      console.log(`  [${check.status}] ${check.check}: ${check.detail}`);
    }
  }
  const { plan } = result;
  console.log(`run: ${plan.runId}`);
  console.log(`validated rows: ${plan.source.totalRows}`);
  console.log(`planned operations: ${plan.operations.length}`);
  console.log(`blocked rows: ${plan.blockedRows.length}`);
  if ("duplicateRows" in plan.source) {
    console.log(`duplicate rows merged: ${plan.source.duplicateRows}`);
  } else {
    console.log(`planned enrollments: ${plan.source.plannedEnrollments}`);
    console.log(`planned progress writes: ${plan.source.plannedProgressWrites}`);
  }
  console.log(`dry-run plan: ${result.planPath}`);
}

type CliOptions = Omit<MigrationCliOptions, "output" | "ledger" | "executeReport"> &
  Partial<Pick<MigrationCliOptions, "output" | "ledger" | "executeReport">> & {
    interactive: boolean;
  };

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    interactive: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--input") {
      options.input = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--profile") {
      options.profile = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--output") {
      options.output = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--approval") {
      options.approval = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--adapter") {
      options.adapter = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--ledger") {
      options.ledger = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--execute-report") {
      options.executeReport = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--env-file") {
      options.envFile = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--execute") {
      options.execute = true;
      continue;
    }

    if (arg === "--allow-dev-execute") {
      options.allowDevExecute = true;
      continue;
    }

    if (arg === "--preflight-dev") {
      options.preflightDev = true;
      continue;
    }

    if (arg === "--sync-catalog") {
      options.syncCatalog = true;
      continue;
    }

    if (arg === "--interactive" || arg === "--tui") {
      options.interactive = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function finalizeCliOptions(options: CliOptions): MigrationCliOptions {
  const completed = { ...options };

  if (completed.input) {
    const derivedPaths = deriveMigrationOutputPaths(completed.input);
    completed.output ??= derivedPaths.output;
    completed.ledger ??= derivedPaths.ledger;
    completed.executeReport ??= derivedPaths.executeReport;
  }

  return {
    ...completed,
    output: completed.output ?? "storage/migration-plan.json",
    ledger: completed.ledger ?? "storage/migration-runs.sqlite",
    executeReport: completed.executeReport ?? "storage/execute-report.json",
  };
}

function readArgValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`);
  }

  return value;
}

function printHelp(): void {
  console.log(`Usage:
  bun run migrate -- --input ./fixtures/members-progress.csv --profile ./examples/profile.tetra.fake.json

Options:
  --input     CSV or XLSX spreadsheet file.
  --profile   Approved local mapping profile JSON.
  --tui       Open the OpenTUI guided importer.
  --interactive Alias for --tui.
  --output    Redacted JSON dry-run plan path. Defaults to ./storage/<input-name>-plan.json.
  --execute   Executes planned operations through the selected adapter.
  --adapter   Execute adapter. Use "fake" or gated "tetra-dev".
  --allow-dev-execute Explicitly allows --adapter tetra-dev after dry-run review.
  --preflight-dev Validate tetra-dev env and access-group/product targets with read-only calls.
  --ledger    Redacted SQLite ledger path. Defaults to ./storage/<input-name>-runs.sqlite.
  --execute-report Redacted JSON execute report path. Defaults to ./storage/<input-name>-execute.json.
  --env-file  Optional local env file for tetra-dev config. Values are loaded in memory only.
  --approval  Production approval JSON file required when --execute targets production.
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
