import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadCatalogMapFromFile, writeCatalogMapToFile } from "./catalog-map";
import {
  executeConsumoFake,
  executeConsumoRun,
  preflightConsumoRun,
  type ConsumoExecuteReport,
  type ConsumoExecutionClients,
  type ConsumoPreflightReport,
} from "./consumo-execute";
import {
  buildConsumoPreparedRun,
  isProfileV2,
  type AnyMappingProfile,
  type ConsumoPreparedRun,
  type ConsumoPrivateContext,
  type ConsumoRunPlan,
} from "./consumo-plan";
import { EXECUTE_ADAPTERS, executeRun, type ExecuteReport } from "./execute";
import { openMigrationLedger, type MigrationLedger } from "./ledger";
import {
  assertExecutionAllowed,
  buildPreparedRun,
  type ApprovalFile,
  type PrivateExecutionContext,
  type RunPlan,
} from "./migration-plan";
import { normalizeLocalPathInput } from "./path-utils";
import {
  executeTetraDevRun,
  preflightTetraDevRun,
  type TetraDevExecutionClients,
  type TetraDevPreflightReport,
} from "./tetra-dev-execute";
import {
  TetraEnrollmentsClient,
  TetraIamClient,
  TetraProductsClient,
  TetraServiceTokenProvider,
} from "./tetra-api";
import { readWorkbook } from "./workbook";

export type MigrationProgressEvent = {
  phase:
    | "validate_paths"
    | "read_workbook"
    | "sync_catalog"
    | "build_plan"
    | "write_plan"
    | "record_ledger"
    | "preflight_tetra_dev"
    | "execute_fake"
    | "execute_tetra_dev"
    | "write_execute_report"
    | "done";
  message: string;
};

export type TetraDevConfig = {
  iamBaseUrl: string;
  enrollmentsBaseUrl: string;
  productsBaseUrl?: string;
  clientId: string;
  clientSecret: string;
  scope: string;
};

export type MigrationCliOptions = {
  input?: string;
  profile?: string;
  output: string;
  execute: boolean;
  adapter?: string;
  approval?: string;
  ledger: string;
  executeReport: string;
  envFile?: string;
  allowDevExecute?: boolean;
  preflightDev?: boolean;
  /** Perfis v2: atualiza o catalog map local via tetra-products antes do plano. */
  syncCatalog?: boolean;
  /** Perfis v2: overrides de janela de matricula digitados na TUI/CLI. */
  consumoOverrides?: {
    accessStartsAt?: string;
    periodicity?: "DAILY" | "MONTHLY" | "YEARLY";
    periodicityValue?: number;
  };
  tetraDevConfig?: TetraDevConfig;
  tetraDevClients?: TetraDevExecutionClients;
  consumoClients?: ConsumoExecutionClients;
  onProgress?: (event: MigrationProgressEvent) => void;
};

export type AnyRunPlan = RunPlan | ConsumoRunPlan;

export type MigrationRunResult = {
  plan: AnyRunPlan;
  planPath: string;
  executeReportPath?: string;
  executeSummary?: {
    adapter: string;
    attemptedOperations: number;
    succeededOperations: number;
    skippedBlockedRows: number;
  };
  executeReport?: ConsumoExecuteReport;
  preflightSummary?: TetraDevPreflightReport["summary"];
  preflightReport?: TetraDevPreflightReport;
  consumoPreflightReport?: ConsumoPreflightReport;
};

export type MigrationPrepareResult = {
  plan: AnyRunPlan;
  planPath: string;
  privateContext: PrivateExecutionContext | ConsumoPrivateContext;
};

export function isConsumoPlan(plan: AnyRunPlan): plan is ConsumoRunPlan {
  return "layout" in plan && plan.layout === "themembers-consumo";
}

export type LegacyMigrationPrepareResult = {
  plan: RunPlan;
  planPath: string;
  privateContext: PrivateExecutionContext;
};

export function assertLegacyPrepared(
  prepared: MigrationPrepareResult,
): LegacyMigrationPrepareResult {
  if (isConsumoPrepared(prepared)) {
    throw new Error("expected a v1 prepared migration");
  }
  return prepared as LegacyMigrationPrepareResult;
}

export function isConsumoPrepared(
  prepared: MigrationPrepareResult,
): prepared is MigrationPrepareResult & ConsumoPreparedRun {
  return isConsumoPlan(prepared.plan);
}

export type MigrationExecuteResult = Required<
  Pick<MigrationRunResult, "executeReportPath" | "executeSummary">
>;

export async function runMigration(options: MigrationCliOptions): Promise<MigrationRunResult> {
  const prepared = await prepareMigrationPlan(options);

  let preflight: TetraDevPreflightReport | undefined;
  let consumoPreflight: ConsumoPreflightReport | undefined;
  if (options.preflightDev) {
    if (isConsumoPrepared(prepared)) {
      consumoPreflight = await preflightConsumoPlan(prepared, options);
    } else {
      preflight = await preflightPreparedMigrationPlan(prepared, options);
    }
  }

  const preflightFields = {
    ...(preflight ? { preflightReport: preflight, preflightSummary: preflight.summary } : {}),
    ...(consumoPreflight ? { consumoPreflightReport: consumoPreflight } : {}),
  };

  if (!options.execute) {
    return { ...prepared, ...preflightFields };
  }

  const executed = await executePreparedMigrationPlan(prepared, options);
  return { ...prepared, ...preflightFields, ...executed };
}

export async function preflightConsumoPlan(
  prepared: MigrationPrepareResult & ConsumoPreparedRun,
  options: MigrationCliOptions,
): Promise<ConsumoPreflightReport> {
  assertTetraDevProfileAllowed(prepared.plan);
  emitProgress(options, "preflight_tetra_dev", "Validando alvo tetra-dev sem mutacao");
  if (options.consumoClients) {
    return preflightConsumoRun(prepared, options.consumoClients);
  }

  const ledger = await openMigrationLedger(resolve(normalizeLocalPathInput(options.ledger)));
  try {
    const clients = await createConsumoClients(options, prepared.plan.tenantId, ledger);
    return await preflightConsumoRun(prepared, clients);
  } finally {
    ledger.close();
  }
}

export async function prepareMigrationPlan(
  options: MigrationCliOptions,
): Promise<MigrationPrepareResult> {
  emitProgress(options, "validate_paths", "Validando caminhos locais");

  if (!options.input) {
    throw new Error("Missing required --input <spreadsheet.csv> argument.");
  }
  if (!options.profile) {
    throw new Error("Missing required --profile <profile.json> argument.");
  }

  const inputPath = resolve(normalizeLocalPathInput(options.input));
  const profilePath = resolve(normalizeLocalPathInput(options.profile));
  const outputPath = resolve(normalizeLocalPathInput(options.output));

  emitProgress(options, "read_workbook", "Lendo planilha");
  const profile = await readJsonFile<AnyMappingProfile>(profilePath);
  const rows = await readWorkbook(inputPath);

  emitProgress(options, "build_plan", "Aplicando perfil e montando plano");
  const prepared = isProfileV2(profile)
    ? await buildConsumoPrepared(rows, profile, options, profilePath)
    : buildPreparedRun(rows, profile);
  const { plan, privateContext } = prepared;
  await assertOptionsExecutionAllowed(options, plan);

  emitProgress(options, "write_plan", "Gravando plano redigido");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);

  const ledger = await openMigrationLedger(resolve(normalizeLocalPathInput(options.ledger)));
  try {
    emitProgress(options, "record_ledger", "Registrando dry-run no ledger");
    if (isConsumoPlan(plan)) {
      ledger.recordConsumoDryRun(plan);
    } else {
      ledger.recordDryRun(plan);
    }

    if (!options.execute) {
      emitProgress(options, "done", "Dry-run concluido");
    }

    return { plan, planPath: outputPath, privateContext };
  } finally {
    ledger.close();
  }
}

async function buildConsumoPrepared(
  rows: Awaited<ReturnType<typeof readWorkbook>>,
  profile: Extract<AnyMappingProfile, { version: 2 }>,
  options: MigrationCliOptions,
  profilePath: string,
): Promise<ConsumoPreparedRun> {
  const catalogMapPath = resolve(dirname(profilePath), normalizeLocalPathInput(profile.catalogMapPath));

  if (options.syncCatalog) {
    emitProgress(options, "sync_catalog", "Sincronizando catalog map do tetra-products");
    const clients =
      options.consumoClients ?? (await createConsumoClients(options, profile.tenantId, undefined));
    if (!clients.products) {
      throw new Error(
        "Catalog sync requires TETRA_PRODUCTS_URI or PRODUCTS_API_BASE_URL in the env config.",
      );
    }
    const courseMap = await clients.products.getCourseMap();
    await writeCatalogMapToFile(catalogMapPath, courseMap);
  }

  const catalogMap = await loadCatalogMapFromFile(catalogMapPath);
  const overrides = options.consumoOverrides;
  const effectiveProfile = overrides
    ? {
        ...profile,
        enrollmentWindow: {
          accessStartsAt: overrides.accessStartsAt ?? profile.enrollmentWindow.accessStartsAt,
          periodicity: overrides.periodicity ?? profile.enrollmentWindow.periodicity,
          periodicityValue:
            overrides.periodicityValue ?? profile.enrollmentWindow.periodicityValue,
        },
      }
    : profile;
  return buildConsumoPreparedRun(rows, effectiveProfile, catalogMap);
}

export async function executePreparedMigrationPlan(
  prepared: RunPlan | MigrationPrepareResult,
  options: MigrationCliOptions,
): Promise<MigrationExecuteResult> {
  const plan = isPreparedMigration(prepared) ? prepared.plan : prepared;

  if (!options.execute) {
    throw new Error("Execute requires --execute.");
  }

  await assertOptionsExecutionAllowed(options, plan, true);

  const ledger = await openMigrationLedger(resolve(normalizeLocalPathInput(options.ledger)));
  try {
    if (isPreparedMigration(prepared) && isConsumoPrepared(prepared)) {
      return await executeConsumoPrepared(prepared, options, ledger);
    }

    const report = await executeWithSelectedAdapter(prepared as RunPlan | LegacyPrepared, options);
    ledger.recordExecute(report);

    emitProgress(options, "write_execute_report", "Gravando relatorio de execute");
    const reportPath = resolve(normalizeLocalPathInput(options.executeReport));
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    emitProgress(options, "done", `Execute ${report.adapter} concluido`);

    return {
      executeReportPath: reportPath,
      executeSummary: {
        adapter: report.adapter,
        attemptedOperations: report.summary.attemptedOperations,
        succeededOperations: report.summary.succeededOperations,
        skippedBlockedRows: report.summary.skippedBlockedRows,
      },
    };
  } finally {
    ledger.close();
  }
}

type LegacyPrepared = {
  plan: RunPlan;
  planPath: string;
  privateContext: PrivateExecutionContext;
};

async function executeConsumoPrepared(
  prepared: MigrationPrepareResult & ConsumoPreparedRun,
  options: MigrationCliOptions,
  ledger: MigrationLedger,
): Promise<MigrationExecuteResult> {
  let report: ConsumoExecuteReport;
  if (options.adapter === EXECUTE_ADAPTERS.fake) {
    emitProgress(options, "execute_fake", "Executando adaptador fake");
    report = executeConsumoFake(prepared.plan);
  } else if (options.adapter === EXECUTE_ADAPTERS.tetraDev) {
    if (!options.allowDevExecute) {
      throw new Error("Tetra dev execute requires an explicit dev execution gate.");
    }
    assertTetraDevProfileAllowed(prepared.plan);
    emitProgress(options, "execute_tetra_dev", "Executando adaptador tetra-dev");
    const clients =
      options.consumoClients ??
      (await createConsumoClients(options, prepared.plan.tenantId, ledger));
    report = await executeConsumoRun(prepared, clients);
  } else {
    throw new Error("Execute requires --adapter fake or --adapter tetra-dev.");
  }

  ledger.recordConsumoExecute(report);

  emitProgress(options, "write_execute_report", "Gravando relatorio de execute");
  const reportPath = resolve(normalizeLocalPathInput(options.executeReport));
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  emitProgress(options, "done", `Execute ${report.adapter} concluido`);

  return {
    executeReportPath: reportPath,
    executeSummary: {
      adapter: report.adapter,
      attemptedOperations: report.summary.memberOperations,
      succeededOperations: report.summary.membersEnsured,
      skippedBlockedRows: report.summary.blockedRows,
    },
  };
}

export async function preflightPreparedMigrationPlan(
  prepared: MigrationPrepareResult,
  options: MigrationCliOptions,
): Promise<TetraDevPreflightReport> {
  if (isConsumoPrepared(prepared)) {
    throw new Error("Consumo plans must use preflightConsumoPlan.");
  }

  assertTetraDevProfileAllowed(prepared.plan);
  emitProgress(options, "preflight_tetra_dev", "Validando alvo tetra-dev sem mutacao");
  return preflightTetraDevRun(
    prepared as LegacyPrepared,
    options.tetraDevClients ?? (await createTetraDevClients(options, prepared.plan.tenantId)),
  );
}

export function loadTetraDevConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): TetraDevConfig {
  const iamBaseUrl = firstEnvValue(env, "TETRA_IAM_URI", "IAM_API_BASE_URL");
  const enrollmentsBaseUrl = firstEnvValue(
    env,
    "TETRA_ENROLLMENTS_URI",
    "ENROLLMENTS_API_BASE_URL",
  );
  const clientId =
    firstEnvValue(env, "IAM_OAUTH_CLIENT_ID", "TETRA_IAM_CLIENT_ID", "IMPORTS_OAUTH_CLIENT_ID") ||
    (env.IMPORTS_OAUTH_CLIENT_SECRET?.trim() ? "tetra-imports-service" : "");
  const clientSecret = firstEnvValue(
    env,
    "IAM_OAUTH_CLIENT_SECRET",
    "TETRA_IAM_CLIENT_SECRET",
    "IMPORTS_OAUTH_CLIENT_SECRET",
  );
  const missing = [
    iamBaseUrl ? null : "TETRA_IAM_URI or IAM_API_BASE_URL",
    enrollmentsBaseUrl ? null : "TETRA_ENROLLMENTS_URI or ENROLLMENTS_API_BASE_URL",
    clientId ? null : "IAM_OAUTH_CLIENT_ID or TETRA_IAM_CLIENT_ID or IMPORTS_OAUTH_CLIENT_ID",
    clientSecret
      ? null
      : "IAM_OAUTH_CLIENT_SECRET or TETRA_IAM_CLIENT_SECRET or IMPORTS_OAUTH_CLIENT_SECRET",
  ].filter((key): key is string => Boolean(key));
  if (missing.length > 0) {
    throw new Error(`Missing Tetra dev config env vars: ${missing.join(", ")}`);
  }

  const productsBaseUrl = firstEnvValue(env, "TETRA_PRODUCTS_URI", "PRODUCTS_API_BASE_URL");

  return {
    iamBaseUrl,
    enrollmentsBaseUrl,
    ...(productsBaseUrl ? { productsBaseUrl } : {}),
    clientId,
    clientSecret,
    scope: env.TETRA_MEMBER_MIGRATION_SERVICE_SCOPE?.trim() || "iam:provision-users",
  };
}

export async function loadTetraDevConfigFromEnvFile(path: string): Promise<TetraDevConfig> {
  const fileEnv = parseEnvFile(await readFile(resolve(normalizeLocalPathInput(path)), "utf8"));
  return loadTetraDevConfigFromEnv({ ...process.env, ...fileEnv });
}

function isPreparedMigration(input: RunPlan | MigrationPrepareResult): input is MigrationPrepareResult {
  return "privateContext" in input;
}

async function executeWithSelectedAdapter(
  prepared: RunPlan | LegacyPrepared,
  options: MigrationCliOptions,
): Promise<ExecuteReport> {
  if (options.adapter === EXECUTE_ADAPTERS.fake) {
    const plan = isPreparedMigration(prepared) ? prepared.plan : prepared;
    emitProgress(options, "execute_fake", "Executando adaptador fake");
    return executeRun(plan, { adapter: EXECUTE_ADAPTERS.fake });
  }

  if (options.adapter === EXECUTE_ADAPTERS.tetraDev) {
    if (!isPreparedMigration(prepared)) {
      throw new Error("Tetra dev execute requires a prepared migration with private context.");
    }
    if (!options.allowDevExecute) {
      throw new Error("Tetra dev execute requires an explicit dev execution gate.");
    }
    assertTetraDevProfileAllowed(prepared.plan);

    emitProgress(options, "execute_tetra_dev", "Executando adaptador tetra-dev");
    return executeTetraDevRun(
      prepared,
      options.tetraDevClients ?? (await createTetraDevClients(options, prepared.plan.tenantId)),
    );
  }

  throw new Error("Execute requires --adapter fake or --adapter tetra-dev.");
}

function assertTetraDevProfileAllowed(plan: AnyRunPlan): void {
  // "production" tambem e permitido aqui: o gate real de producao e o
  // approval file (assertExecutionAllowed), validado no prepare e no execute.
  if (
    plan.environment !== "dev" &&
    plan.environment !== "local" &&
    plan.environment !== "production"
  ) {
    throw new Error("Tetra adapter only supports local, dev or production profiles.");
  }
}

function firstEnvValue(env: Record<string, string | undefined>, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

async function createTetraDevClients(
  options: MigrationCliOptions,
  tenantId: string,
): Promise<TetraDevExecutionClients> {
  const config = await resolveTetraDevConfig(options);
  const tokenProvider = new TetraServiceTokenProvider({
    iamBaseUrl: config.iamBaseUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: config.scope,
  });

  return {
    iam: new TetraIamClient({
      iamBaseUrl: config.iamBaseUrl,
      tokenProvider,
    }),
    enrollments: new TetraEnrollmentsClient({
      enrollmentsBaseUrl: config.enrollmentsBaseUrl,
      tenantId,
    }),
  };
}

async function createConsumoClients(
  options: MigrationCliOptions,
  tenantId: string,
  accessGroupStore: MigrationLedger | undefined,
): Promise<ConsumoExecutionClients> {
  const config = await resolveTetraDevConfig(options);
  const tokenProvider = new TetraServiceTokenProvider({
    iamBaseUrl: config.iamBaseUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: config.scope,
  });

  return {
    iam: new TetraIamClient({
      iamBaseUrl: config.iamBaseUrl,
      tokenProvider,
    }),
    enrollments: new TetraEnrollmentsClient({
      enrollmentsBaseUrl: config.enrollmentsBaseUrl,
      tenantId,
      tokenProvider,
    }),
    ...(config.productsBaseUrl
      ? {
          products: new TetraProductsClient({
            productsBaseUrl: config.productsBaseUrl,
            tenantId,
            tokenProvider,
          }),
        }
      : {}),
    ...(accessGroupStore ? { accessGroupStore } : {}),
  };
}

async function resolveTetraDevConfig(options: MigrationCliOptions): Promise<TetraDevConfig> {
  return (
    options.tetraDevConfig ??
    (options.envFile
      ? await loadTetraDevConfigFromEnvFile(options.envFile)
      : loadTetraDevConfigFromEnv())
  );
}

function parseEnvFile(input: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    env[key] = unquoteEnvValue(trimmed.slice(separatorIndex + 1).trim());
  }

  return env;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function assertOptionsExecutionAllowed(
  options: MigrationCliOptions,
  plan: Pick<RunPlan, "runId" | "tenantId" | "environment">,
  forceExecute = false,
): Promise<void> {
  const approval = await readApprovalFile(options);
  assertExecutionAllowed({
    execute: forceExecute || options.execute,
    plan,
    ...(approval ? { approval } : {}),
  });
}

async function readApprovalFile(options: MigrationCliOptions): Promise<ApprovalFile | undefined> {
  if (!options.approval) {
    return undefined;
  }

  return readJsonFile<ApprovalFile>(resolve(normalizeLocalPathInput(options.approval)));
}

function emitProgress(
  options: MigrationCliOptions,
  phase: MigrationProgressEvent["phase"],
  message: string,
): void {
  options.onProgress?.({ phase, message });
}

async function readJsonFile<T>(path: string): Promise<T> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as T;
}
