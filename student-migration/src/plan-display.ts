import type { ConsumoRunPlan } from "./consumo-plan";
import type {
  BlockedRow,
  EvidenceOnlyRow,
  PlannedOperation,
  ProgressEvidence,
  ResolvedProduct,
  RunPlan,
  SourceRef,
} from "./migration-plan";
import { describeRemaining } from "./period";

export type PlanDisplayOptions = {
  maxOperations?: number;
  maxBlockedRows?: number;
  maxEvidenceOnlyRows?: number;
};

export function formatAnyPlanForTui(
  plan: RunPlan | ConsumoRunPlan,
  options: PlanDisplayOptions = {},
): string {
  if ("layout" in plan && plan.layout === "themembers-consumo") {
    return formatConsumoPlanForTui(plan, options);
  }
  return formatRunPlanForTui(plan as RunPlan, options);
}

export function formatConsumoPlanForTui(
  plan: ConsumoRunPlan,
  options: PlanDisplayOptions = {},
  now = new Date(),
): string {
  const remaining = describeRemaining(now, plan.enrollmentWindow.accessEndsAt);
  const windowStatus = remaining.expired
    ? "JANELA JA EXPIRADA - confirme se e intencional"
    : `${remaining.remainingDays} dia(s) restantes`;
  const accessGroupLine =
    plan.accessGroup.mode === "existing"
      ? `Grupo de acesso: existente ${plan.accessGroup.id}${plan.accessGroup.name ? ` (${plan.accessGroup.name})` : ""}`
      : `Grupo de acesso: criar "${plan.accessGroup.name}" (${plan.accessGroup.periodicity} x${plan.accessGroup.periodicityValue})`;

  const lines = [
    "Plano redigido (TheMembers consumo)",
    `Run: ${plan.runId}`,
    `Tenant: ${plan.tenantId}`,
    `Ambiente: ${plan.environment}`,
    `Gerado em: ${plan.generatedAt}`,
    accessGroupLine,
    `Janela de matricula: ${plan.enrollmentWindow.accessStartsAt} -> ${plan.enrollmentWindow.accessEndsAt} (${windowStatus})`,
    "",
    "Resumo",
    `Linhas da planilha: ${plan.source.totalRows}`,
    `Membros a migrar: ${plan.source.memberOperations}`,
    `Matriculas planejadas: ${plan.source.plannedEnrollments}`,
    `Progressos planejados: ${plan.source.plannedProgressWrites}`,
    `Linhas bloqueadas: ${plan.source.blockedRows}`,
    `Progressos bloqueados (linha segue): ${plan.source.progressOnlyBlockedRows}`,
    "",
    ...formatBlockedReasonCounts(plan.blockedReasonCounts),
    "",
    ...formatCatalogIssues(plan),
    "",
    ...formatEnrollmentsPerCourse(plan),
    "",
    ...formatConsumoBlockedRows(plan, options.maxBlockedRows ?? 10),
  ];

  return lines.join("\n").trimEnd();
}

function formatBlockedReasonCounts(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return ["Bloqueios por motivo", "Nenhum bloqueio."];
  }
  return ["Bloqueios por motivo", ...entries.map(([reason, count]) => `  ${count}x ${reason}`)];
}

function formatCatalogIssues(plan: ConsumoRunPlan): string[] {
  const lines = ["Catalogo"];
  if (
    plan.catalog.ambiguousCourseTitles.length === 0 &&
    plan.catalog.unresolvedCourseTitles.length === 0 &&
    plan.catalog.unresolvedLessonTitles.length === 0
  ) {
    lines.push("Todos os titulos resolvidos no catalog map.");
    return lines;
  }

  if (plan.catalog.ambiguousCourseTitles.length > 0) {
    lines.push(`Cursos ambiguos: ${plan.catalog.ambiguousCourseTitles.join("; ")}`);
  }
  if (plan.catalog.unresolvedCourseTitles.length > 0) {
    lines.push(`Cursos nao encontrados: ${plan.catalog.unresolvedCourseTitles.join("; ")}`);
  }
  if (plan.catalog.unresolvedLessonTitles.length > 0) {
    const visible = plan.catalog.unresolvedLessonTitles.slice(0, 10);
    lines.push(`Aulas nao resolvidas (${plan.catalog.unresolvedLessonTitles.length}):`);
    lines.push(...visible.map((title) => `  ${title}`));
    if (plan.catalog.unresolvedLessonTitles.length > visible.length) {
      lines.push(`  ... ${plan.catalog.unresolvedLessonTitles.length - visible.length} adicionais.`);
    }
  }
  return lines;
}

function formatEnrollmentsPerCourse(plan: ConsumoRunPlan): string[] {
  const counts = new Map<string, number>();
  for (const operation of plan.operations) {
    for (const enrollment of operation.enrollments) {
      counts.set(enrollment.courseTitle, (counts.get(enrollment.courseTitle) ?? 0) + 1);
    }
  }

  if (counts.size === 0) {
    return ["Matriculas por curso", "Nenhuma matricula planejada."];
  }

  return [
    "Matriculas por curso",
    ...Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([title, count]) => `  ${count}x ${title}`),
  ];
}

function formatConsumoBlockedRows(plan: ConsumoRunPlan, maxItems: number): string[] {
  if (plan.blockedRows.length === 0) {
    return ["Linhas bloqueadas", "Nenhuma linha bloqueada."];
  }

  const visible = plan.blockedRows.slice(0, maxItems);
  const lines = ["Linhas bloqueadas (amostra)"];
  visible.forEach((row, index) => {
    lines.push(
      `Bloqueio ${index + 1}: ${formatSourceRef(row.sourceRef)} [${row.scope}]`,
      `  Motivos: ${row.reasons.join("; ")}`,
    );
  });
  if (plan.blockedRows.length > visible.length) {
    lines.push(`... ${plan.blockedRows.length - visible.length} bloqueios adicionais no plano.`);
  }
  return lines;
}

export function formatRunPlanForTui(plan: RunPlan, options: PlanDisplayOptions = {}): string {
  const lines = [
    "Plano redigido",
    `Run: ${plan.runId}`,
    `Tenant: ${plan.tenantId}`,
    `Ambiente: ${plan.environment}`,
    `Gerado em: ${plan.generatedAt}`,
    "",
    "Resumo",
    `Linhas validadas: ${plan.source.totalRows}`,
    `Operacoes validas: ${plan.operations.length}`,
    `Bloqueadas: ${plan.blockedRows.length}`,
    `Somente evidencia: ${plan.evidenceOnlyRows.length}`,
    `Duplicadas agrupadas: ${plan.source.duplicateRows}`,
    "",
    ...formatOperations(plan.operations, options.maxOperations),
    "",
    ...formatBlockedRows(plan.blockedRows, options.maxBlockedRows),
    "",
    ...formatEvidenceOnlyRows(plan.evidenceOnlyRows, options.maxEvidenceOnlyRows),
  ];

  return lines.join("\n").trimEnd();
}

function formatOperations(operations: PlannedOperation[], maxItems?: number): string[] {
  if (operations.length === 0) {
    return ["Operacoes", "Nenhuma operacao valida."];
  }

  const visible = limitItems(operations, maxItems);
  const lines = ["Operacoes"];
  visible.items.forEach((operation, index) => {
    lines.push(
      `Operacao ${index + 1}: ${operation.operationId}`,
      `  Membro: hash:${shortHash(operation.member.memberHash)} | nome: ${yesNo(operation.member.hasName)} | telefone: ${yesNo(operation.member.hasPhoneEvidence)}`,
      `  Origem: ${formatSourceRefs(operation.sourceRefs)}`,
      `  Grupo de acesso: ${operation.accessGroup.name} (${operation.accessGroup.id})`,
      `  Produto: ${formatProduct(operation.product)}`,
      `  Idempotencia: ${operation.idempotencyKey}`,
      `  Acao: ${operation.action}`,
      ...formatEvidence(operation.evidence, "  "),
    );
  });
  appendHiddenCount(lines, visible.hiddenCount, "operacoes");
  return lines;
}

function formatBlockedRows(rows: BlockedRow[], maxItems?: number): string[] {
  if (rows.length === 0) {
    return ["Linhas bloqueadas", "Nenhuma linha bloqueada."];
  }

  const visible = limitItems(rows, maxItems);
  const lines = ["Linhas bloqueadas"];
  visible.items.forEach((row, index) => {
    lines.push(
      `Linha bloqueada ${index + 1}: ${formatSourceRef(row.sourceRef)}`,
      `  Membro: ${row.memberHash ? `hash:${shortHash(row.memberHash)}` : "sem hash"}`,
      `  Motivos: ${row.reasons.join("; ")}`,
      ...formatEvidence(row.evidence, "  "),
    );
  });
  appendHiddenCount(lines, visible.hiddenCount, "linhas bloqueadas");
  return lines;
}

function formatEvidenceOnlyRows(rows: EvidenceOnlyRow[], maxItems?: number): string[] {
  if (rows.length === 0) {
    return ["Linhas somente evidencia", "Nenhuma linha somente evidencia."];
  }

  const visible = limitItems(rows, maxItems);
  const lines = ["Linhas somente evidencia"];
  visible.items.forEach((row, index) => {
    lines.push(
      `Linha evidencia ${index + 1}: ${formatSourceRef(row.sourceRef)}`,
      `  Membro: ${row.memberHash ? `hash:${shortHash(row.memberHash)}` : "sem hash"}`,
      `  Motivo: ${row.reason}`,
      ...formatEvidence(row.evidence, "  "),
    );
  });
  appendHiddenCount(lines, visible.hiddenCount, "linhas somente evidencia");
  return lines;
}

function formatEvidence(evidence: ProgressEvidence, prefix: string): string[] {
  return [
    `${prefix}Progresso informado: ${yesNo(evidence.hasProgressPercent)}`,
    `${prefix}Conclusao informada: ${yesNo(evidence.hasCompletionFlag)}`,
    `${prefix}Acesso historico informado: ${yesNo(evidence.hasHistoricalAccessDate)}`,
    `${prefix}Escrita de progresso: ${evidence.progressWritePlanned ? "planejada" : "nao planejada"}`,
  ];
}

function formatProduct(product: ResolvedProduct): string {
  const course = product.courseId ? `, course ${product.courseId}` : "";
  return `${product.name} (${product.id}, ${product.type}${course})`;
}

function formatSourceRefs(sourceRefs: SourceRef[]): string {
  return sourceRefs.map(formatSourceRef).join(", ");
}

function formatSourceRef(sourceRef: SourceRef): string {
  return `${sourceRef.sheetName}:${sourceRef.rowNumber}`;
}

function limitItems<T>(
  items: T[],
  maxItems: number | undefined,
): { items: T[]; hiddenCount: number } {
  if (!Number.isInteger(maxItems) || maxItems === undefined || maxItems < 0) {
    return { items, hiddenCount: 0 };
  }
  return {
    items: items.slice(0, maxItems),
    hiddenCount: Math.max(0, items.length - maxItems),
  };
}

function appendHiddenCount(lines: string[], hiddenCount: number, label: string): void {
  if (hiddenCount > 0) {
    lines.push(`... ${hiddenCount} ${label} adicionais no plano redigido.`);
  }
}

function shortHash(value: string): string {
  return value.slice(0, 12);
}

function yesNo(value: boolean): string {
  return value ? "sim" : "nao";
}
