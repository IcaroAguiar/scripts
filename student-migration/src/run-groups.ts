// Orquestracao do modo "grupos de migracao": le o CSV de assinaturas do
// TheMembers e o xlsx de cursos, monta o plano revisavel (JSON + CSV) e, sob
// os mesmos gates do fluxo consumo, executa criacao/vinculo idempotente.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { loadCatalogMapFromFile, writeCatalogMapToFile, type CatalogMap } from "./catalog-map";
import { parseCourseList } from "./course-list";
import {
  executeGroupsFake,
  executeGroupsRun,
  type GroupsExecuteReport,
  type GroupsExecutionClients,
} from "./groups-execute";
import {
  describePeriodicity,
  normalizeGroupName,
  parsePeriodicityFromName,
} from "./group-naming";
import { buildGroupsPlan, type GroupsEnvironment, type GroupsRunPlan } from "./groups-plan";
import { readTheMembersProductsFile } from "./layouts/themembers-products";
import { openMigrationLedger } from "./ledger";
import { assertExecutionAllowed, type ApprovalFile } from "./migration-plan";
import { normalizeLocalPathInput } from "./path-utils";
import { TetraEnrollmentsClient, TetraProductsClient, TetraServiceTokenProvider } from "./tetra-api";
import { loadTetraDevConfigFromEnv, loadTetraDevConfigFromEnvFile, type TetraDevConfig } from "./run-migration";
import { readWorkbookMatrix } from "./workbook";

export type GroupsCliOptions = {
  productsCsv: string;
  coursesXlsx: string;
  tenantId: string;
  environment: GroupsEnvironment;
  catalogMap?: string;
  syncCatalog?: boolean;
  execute?: boolean;
  adapter?: string;
  allowDevExecute?: boolean;
  approval?: string;
  envFile?: string;
  output?: string;
  reviewCsv?: string;
  executeReport?: string;
  ledger?: string;
  tetraDevConfig?: TetraDevConfig;
  groupsClients?: GroupsExecutionClients;
  catalogMapOverride?: CatalogMap;
};

export type GroupsRunResult = {
  plan: GroupsRunPlan;
  planPath: string;
  reviewCsvPath: string;
  ambiguousCsvPath: string;
  applyCsvPath: string;
  skippedLines: number;
  executeReport?: GroupsExecuteReport;
  executeReportPath?: string;
};

export async function runGroupsMigration(options: GroupsCliOptions): Promise<GroupsRunResult> {
  const paths = deriveGroupsOutputPaths(options);

  const productsFile = await readTheMembersProductsFile(
    resolve(normalizeLocalPathInput(options.productsCsv)),
  );
  const matrix = await readWorkbookMatrix(resolve(normalizeLocalPathInput(options.coursesXlsx)));
  const courseList = parseCourseList(matrix);
  const catalogMap = await resolveCatalogMap(options, paths.catalogMap);

  const plan = buildGroupsPlan({
    tenantId: options.tenantId,
    environment: options.environment,
    products: productsFile.products,
    courseList,
    catalogMap,
  });

  await assertGroupsExecutionAllowed(options, plan);

  await mkdir(dirname(paths.output), { recursive: true });
  await writeFile(paths.output, `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(paths.reviewCsv, buildReviewCsv(plan));
  await writeFile(paths.ambiguousCsv, buildAmbiguousCsv(plan));
  await writeFile(paths.applyCsv, buildApplyCsv(plan));

  const base: GroupsRunResult = {
    plan,
    planPath: paths.output,
    reviewCsvPath: paths.reviewCsv,
    ambiguousCsvPath: paths.ambiguousCsv,
    applyCsvPath: paths.applyCsv,
    skippedLines: productsFile.skippedLines.length,
  };

  if (!options.execute) {
    return base;
  }

  const report = await executeGroupsPlan(plan, options, paths.ledger);
  await mkdir(dirname(paths.executeReport), { recursive: true });
  await writeFile(paths.executeReport, `${JSON.stringify(report, null, 2)}\n`);

  return { ...base, executeReport: report, executeReportPath: paths.executeReport };
}

async function executeGroupsPlan(
  plan: GroupsRunPlan,
  options: GroupsCliOptions,
  ledgerPath: string,
): Promise<GroupsExecuteReport> {
  if (options.adapter === "fake") {
    return executeGroupsFake(plan);
  }

  if (options.adapter !== "tetra-dev") {
    throw new Error("Groups execute requires --adapter fake or --adapter tetra-dev.");
  }
  if (!options.allowDevExecute) {
    throw new Error("Tetra dev execute requires an explicit dev execution gate.");
  }

  if (options.groupsClients) {
    return executeGroupsRun(plan, options.groupsClients);
  }

  const ledger = await openMigrationLedger(ledgerPath);
  try {
    const config = await resolveConfig(options);
    const tokenProvider = new TetraServiceTokenProvider({
      iamBaseUrl: config.iamBaseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      scope: config.scope,
    });
    const clients: GroupsExecutionClients = {
      enrollments: new TetraEnrollmentsClient({
        enrollmentsBaseUrl: config.enrollmentsBaseUrl,
        tenantId: plan.tenantId,
        tokenProvider,
      }),
      accessGroupStore: ledger,
      productGroupStore: ledger,
    };
    return await executeGroupsRun(plan, clients);
  } finally {
    ledger.close();
  }
}

async function resolveCatalogMap(
  options: GroupsCliOptions,
  catalogMapPath: string,
): Promise<CatalogMap> {
  if (options.catalogMapOverride) {
    return options.catalogMapOverride;
  }

  if (options.syncCatalog) {
    const config = await resolveConfig(options);
    if (!config.productsBaseUrl) {
      throw new Error(
        "Catalog sync requires TETRA_PRODUCTS_URI or PRODUCTS_API_BASE_URL in the env config.",
      );
    }
    const tokenProvider = new TetraServiceTokenProvider({
      iamBaseUrl: config.iamBaseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      scope: config.scope,
    });
    const products = new TetraProductsClient({
      productsBaseUrl: config.productsBaseUrl,
      tenantId: options.tenantId,
      tokenProvider,
    });
    const courseMap = await products.getCourseMap();
    await mkdir(dirname(catalogMapPath), { recursive: true });
    await writeCatalogMapToFile(catalogMapPath, courseMap);
  }

  return loadCatalogMapFromFile(catalogMapPath);
}

async function resolveConfig(options: GroupsCliOptions): Promise<TetraDevConfig> {
  return (
    options.tetraDevConfig ??
    (options.envFile
      ? await loadTetraDevConfigFromEnvFile(options.envFile)
      : loadTetraDevConfigFromEnv())
  );
}

async function assertGroupsExecutionAllowed(
  options: GroupsCliOptions,
  plan: GroupsRunPlan,
): Promise<void> {
  let approval: ApprovalFile | undefined;
  if (options.approval) {
    approval = JSON.parse(
      await readFile(resolve(normalizeLocalPathInput(options.approval)), "utf8"),
    ) as ApprovalFile;
  }

  assertExecutionAllowed({
    execute: options.execute ?? false,
    plan: { runId: plan.runId, tenantId: plan.tenantId, environment: plan.environment },
    ...(approval ? { approval } : {}),
  });
}

export type GroupsOutputPaths = {
  output: string;
  reviewCsv: string;
  ambiguousCsv: string;
  applyCsv: string;
  executeReport: string;
  ledger: string;
  catalogMap: string;
};

export function deriveGroupsOutputPaths(
  options: Pick<
    GroupsCliOptions,
    "productsCsv" | "output" | "reviewCsv" | "executeReport" | "ledger" | "catalogMap"
  >,
): GroupsOutputPaths {
  const normalized = normalizeLocalPathInput(options.productsCsv);
  const stem = basename(normalized, extname(normalized));
  const slug =
    stem
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "groups";

  return {
    output: resolve(normalizeLocalPathInput(options.output ?? join("storage", `${slug}-groups-plan.json`))),
    reviewCsv: resolve(
      normalizeLocalPathInput(options.reviewCsv ?? join("storage", `${slug}-groups-review.csv`)),
    ),
    ambiguousCsv: resolve(
      normalizeLocalPathInput(join("storage", `${slug}-groups-ambiguous.csv`)),
    ),
    applyCsv: resolve(normalizeLocalPathInput(join("storage", `${slug}-groups-apply.csv`))),
    executeReport: resolve(
      normalizeLocalPathInput(options.executeReport ?? join("storage", `${slug}-groups-execute.json`)),
    ),
    ledger: resolve(normalizeLocalPathInput(options.ledger ?? join("storage", `${slug}-runs.sqlite`))),
    catalogMap: resolve(
      normalizeLocalPathInput(options.catalogMap ?? join("storage", "catalog-map.json")),
    ),
  };
}

export function buildReviewCsv(plan: GroupsRunPlan): string {
  const lines: string[] = [
    [
      "status",
      "type",
      "final_name",
      "periodicity",
      "periodicity_value",
      "periodicity_note",
      "students_total",
      "courses_resolved",
      "courses_unresolved",
      "themembers_product_id",
      "raw_product_name",
      "student_count",
    ].join(";"),
  ];

  for (const group of plan.groups) {
    const resolved = group.courses.filter((course) => course.resolution === "resolved").length;
    const unresolved = group.courses.length - resolved;
    for (const source of group.sourceProducts) {
      lines.push(
        [
          group.status,
          group.type,
          csvField(group.finalName),
          group.periodicity ?? "",
          group.periodicityValue?.toString() ?? "",
          csvField(group.periodicityNote ?? ""),
          group.totalStudents.toString(),
          resolved.toString(),
          unresolved.toString(),
          source.productId,
          csvField(source.rawName),
          source.studentCount.toString(),
        ].join(";"),
      );
    }
  }

  for (const product of plan.ambiguousProducts) {
    lines.push(
      [
        "ambiguous",
        "",
        "",
        "",
        "",
        csvField(product.reason ?? ""),
        "",
        "",
        "",
        product.productId,
        csvField(product.rawName),
        product.studentCount.toString(),
      ].join(";"),
    );
  }

  for (const product of plan.excludedProducts) {
    lines.push(
      [
        "excluded",
        "",
        "",
        "",
        "",
        csvField(product.reason ?? ""),
        "",
        "",
        "",
        product.productId,
        csvField(product.rawName),
        product.studentCount.toString(),
      ].join(";"),
    );
  }

  for (const product of plan.outOfScopeProducts) {
    lines.push(
      [
        "out-of-scope",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        product.productId,
        csvField(product.rawName),
        product.studentCount.toString(),
      ].join(";"),
    );
  }

  const unresolvedTitles = new Set<string>();
  for (const group of plan.groups) {
    for (const course of group.courses) {
      if (course.resolution !== "resolved") {
        unresolvedTitles.add(`${group.type}: ${course.title} (${course.resolution})`);
      }
    }
  }
  if (unresolvedTitles.size > 0) {
    lines.push("");
    lines.push("unresolved_courses");
    for (const title of Array.from(unresolvedTitles).sort()) {
      lines.push(csvField(title));
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * CSV dedicado ao que precisa de decisao humana: produtos com classificacao
 * ambigua e grupos com periodicidade conflitante. Colunas pensadas para
 * leitura direta no Excel; escopo e o GRUPO de acesso, nao os alunos.
 */
export function buildAmbiguousCsv(plan: GroupsRunPlan): string {
  const lines: string[] = [
    [
      "pendencia",
      "produto_no_themembers",
      "grupo_que_seria_criado",
      "periodicidade_detectada",
      "motivo",
      "decisao (preencher)",
      "product_id",
    ].join(";"),
  ];

  for (const product of plan.ambiguousProducts) {
    const periodicity = parsePeriodicityFromName(product.rawName);
    lines.push(
      [
        "classificacao",
        csvField(product.rawName),
        csvField(normalizeGroupName(product.rawName)),
        csvField(describePeriodicityParse(periodicity)),
        csvField(product.reason ?? ""),
        "",
        product.productId,
      ].join(";"),
    );
  }

  for (const group of plan.groups) {
    if (group.status !== "ambiguous-periodicity") continue;
    for (const source of group.sourceProducts) {
      lines.push(
        [
          "periodicidade",
          csvField(source.rawName),
          csvField(group.finalName),
          csvField(group.periodicityNote ?? ""),
          "periodicidade conflitante no nome",
          "",
          source.productId,
        ].join(";"),
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * CSV do que SERA aplicado no execute: uma linha por grupo executavel,
 * ordenado por tipo e nome para facilitar a caca a consolidacoes manuais.
 */
export function buildApplyCsv(plan: GroupsRunPlan): string {
  const lines: string[] = [
    [
      "tipo",
      "grupo_a_criar",
      "periodicidade",
      "produtos_origem",
      "nomes_origem_no_themembers",
      "cursos_vinculados",
      "cursos_sem_match",
    ].join(";"),
  ];

  const groups = [...plan.groups]
    .filter((group) => group.status === "ok")
    .sort(
      (a, b) => a.type.localeCompare(b.type) || a.finalName.localeCompare(b.finalName, "pt-BR"),
    );

  for (const group of groups) {
    const resolved = group.courses.filter((course) => course.resolution === "resolved").length;
    lines.push(
      [
        group.type,
        csvField(group.finalName),
        csvField(group.periodicityNote ?? ""),
        group.sourceProducts.length.toString(),
        csvField(group.sourceProducts.map((source) => source.rawName).join(" || ")),
        resolved.toString(),
        (group.courses.length - resolved).toString(),
      ].join(";"),
    );
  }

  return `${lines.join("\n")}\n`;
}

function describePeriodicityParse(
  parse: ReturnType<typeof parsePeriodicityFromName>,
): string {
  switch (parse.status) {
    case "parsed":
      return describePeriodicity(parse.value);
    case "lifetime":
      return "vitalicio (sem periodicidade)";
    case "conflicting":
      return parse.detail;
    default:
      return "sem mencao";
  }
}

function csvField(value: string): string {
  if (/[";\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
