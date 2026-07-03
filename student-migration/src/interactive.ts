import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import {
  buildInteractiveOptions,
  type InteractiveAnswers,
  type InteractiveMode,
} from "./interactive-model";
import { readFileSync } from "node:fs";
import type { ConsumoPreflightReport } from "./consumo-execute";
import { normalizeLocalPathInput } from "./path-utils";
import { deriveMigrationOutputPaths } from "./output-paths";
import { computeAccessEndsAt, describeRemaining } from "./period";
import { formatAnyPlanForTui } from "./plan-display";
import {
  executePreparedMigrationPlan,
  isConsumoPrepared,
  preflightConsumoPlan,
  preflightPreparedMigrationPlan,
  prepareMigrationPlan,
  type MigrationCliOptions,
  type MigrationExecuteResult,
  type MigrationPrepareResult,
} from "./run-migration";
import type { TetraDevPreflightReport } from "./tetra-dev-execute";

type WizardStep =
  | "mode"
  | "input"
  | "profile"
  | "startsAt"
  | "periodicity"
  | "periodicityValue"
  | "catalog"
  | "envFile"
  | "confirm";

type WizardState = Partial<InteractiveAnswers> & {
  step: WizardStep;
  isConsumoProfile?: boolean;
};

export type InteractiveMigrationDependencies = {
  prepareMigrationPlan: typeof prepareMigrationPlan;
  preflightPreparedMigrationPlan: typeof preflightPreparedMigrationPlan;
  preflightConsumoPlan?: typeof preflightConsumoPlan;
  executePreparedMigrationPlan: typeof executePreparedMigrationPlan;
};

const DEFAULT_INPUT = "./fixtures/members-progress.xlsx";
const DEFAULT_PROFILE = "./examples/profile.tetra.fake.json";

const DEFAULT_DEPENDENCIES: InteractiveMigrationDependencies = {
  prepareMigrationPlan,
  preflightPreparedMigrationPlan,
  preflightConsumoPlan,
  executePreparedMigrationPlan,
};

function detectConsumoProfile(state: WizardState): void {
  state.isConsumoProfile = false;
  if (!state.profile) return;

  try {
    const parsed = JSON.parse(
      readFileSync(normalizeLocalPathInput(state.profile), "utf8"),
    ) as {
      version?: number;
      layout?: string;
      enrollmentWindow?: {
        accessStartsAt?: string;
        periodicity?: "DAILY" | "MONTHLY" | "YEARLY";
        periodicityValue?: number;
      };
    };
    if (parsed.version === 2 && parsed.layout === "themembers-consumo") {
      state.isConsumoProfile = true;
      if (!state.startsAt && parsed.enrollmentWindow?.accessStartsAt) {
        state.startsAt = parsed.enrollmentWindow.accessStartsAt;
      }
      if (!state.periodicity && parsed.enrollmentWindow?.periodicity) {
        state.periodicity = parsed.enrollmentWindow.periodicity;
      }
      if (!state.periodicityValue && parsed.enrollmentWindow?.periodicityValue) {
        state.periodicityValue = String(parsed.enrollmentWindow.periodicityValue);
      }
    }
  } catch {
    // Perfil ilegivel aqui vira erro claro no prepare; a TUI segue o fluxo v1.
  }
}

function describeEnrollmentWindow(state: WizardState): string | undefined {
  if (!state.isConsumoProfile || !state.startsAt || !state.periodicity) {
    return undefined;
  }

  try {
    const value = Number.parseInt(state.periodicityValue ?? "1", 10) || 1;
    const window = computeAccessEndsAt(state.startsAt, state.periodicity, value);
    const remaining = describeRemaining(new Date(), window.accessEndsAtIso);
    const status = remaining.expired
      ? "JA EXPIRADA - confirme se e intencional"
      : `${remaining.remainingDays} dia(s) restantes`;
    return `Janela: ${state.startsAt} + ${state.periodicity} x${value} -> ${window.accessEndsAtIso.slice(0, 10)} (${status})`;
  } catch (error) {
    return `Janela invalida: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function runInteractiveMigration(): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });

  return runInteractiveMigrationWithRenderer(renderer);
}

export function runInteractiveMigrationWithRenderer(
  renderer: CliRenderer,
  dependencies: InteractiveMigrationDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  return new Promise((resolve) => {
    const state: WizardState = {
      step: "input",
      mode: "dry-run",
      input: DEFAULT_INPUT,
      profile: DEFAULT_PROFILE,
    };

    const finish = () => {
      renderer.destroy();
      resolve();
    };

    renderer.keyInput.on("keypress", (key) => {
      if (key.name === "escape") {
        finish();
      }
    });

    const rerender = () => renderWizard(renderer, state, rerender, finish, dependencies);
    rerender();
  });
}

function renderWizard(
  renderer: CliRenderer,
  state: WizardState,
  rerender: () => void,
  finish: () => void,
  dependencies: InteractiveMigrationDependencies,
): void {
  replaceScreen(renderer);

  const screen = new BoxRenderable(renderer, {
    id: "screen",
    width: "100%",
    height: "100%",
    padding: 1,
    flexDirection: "column",
    gap: 1,
  });

  screen.add(
    new TextRenderable(renderer, {
      id: "title",
      content: "Importar Membros Tetra",
      fg: "#7dd3fc",
      attributes: TextAttributes.BOLD,
    }),
  );
  screen.add(
    new TextRenderable(renderer, {
      id: "subtitle",
      content: "ESC sai. ENTER confirma. O plano redigido aparece antes do execute.",
      fg: "#cbd5e1",
    }),
  );
  screen.add(buildProgress(renderer, state));

  if (state.step === "mode") {
    screen.add(buildModeSelect(renderer, state, rerender));
  } else if (state.step === "periodicity") {
    screen.add(buildPeriodicitySelect(renderer, state, rerender));
  } else if (state.step === "catalog") {
    screen.add(buildCatalogSelect(renderer, state, rerender));
  } else if (state.step === "confirm") {
    screen.add(buildConfirmSelect(renderer, state, rerender, finish, dependencies));
  } else {
    screen.add(buildTextInput(renderer, state, rerender));
  }

  renderer.root.add(screen);
  screen.findDescendantById("control")?.focus();
  renderer.requestRender();
}

function buildProgress(renderer: CliRenderer, state: WizardState): TextRenderable {
  const modeLabel = getModeLabel(state.mode);
  const paths = deriveMigrationOutputPaths(state.input || DEFAULT_INPUT);
  const windowLine = describeEnrollmentWindow(state);
  return new TextRenderable(renderer, {
    id: "progress",
    content: [
      `Modo: ${modeLabel}`,
      `Planilha local: ${state.input || "(pendente)"}`,
      `Perfil: ${state.profile || "(pendente)"}${state.isConsumoProfile ? " [themembers-consumo]" : ""}`,
      ...(windowLine ? [windowLine] : []),
      ...(state.isConsumoProfile
        ? [`Catalogo: ${state.syncCatalog ? "sincronizar do tetra-products" : "usar mapa local"}`]
        : []),
      ...(state.mode === "execute-dev" ? [`Env dev: ${state.envFile || "(process.env)"}`] : []),
      `Plano: ${state.output || paths.output}`,
      `Ledger: ${state.ledger || paths.ledger}`,
      `Relatorio: ${state.executeReport || paths.executeReport}`,
    ].join("\n"),
    fg: "#94a3b8",
  });
}

function buildModeSelect(
  renderer: CliRenderer,
  state: WizardState,
  rerender: () => void,
): SelectRenderable {
  const select = new SelectRenderable(renderer, {
    id: "control",
    width: "100%",
    height: 6,
    showDescription: true,
    options: [
      {
        name: "Dry-run redigido",
        description: "Gera plano JSON e ledger sem executar operacoes.",
        value: "dry-run",
      },
      {
        name: "Execute fake",
        description: "Executa apenas o adaptador fake local e grava relatorio redigido.",
        value: "execute-fake",
      },
      {
        name: "Execute dev",
        description: "Usa adapter tetra-dev com env local, depois da revisao inline do plano.",
        value: "execute-dev",
      },
    ],
    selectedIndex: state.mode === "execute-dev" ? 2 : state.mode === "execute-fake" ? 1 : 0,
    selectedBackgroundColor: "#164e63",
    selectedTextColor: "#ffffff",
  });

  select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    state.mode = option.value as InteractiveMode;
    state.step = state.mode === "execute-dev" ? "envFile" : "confirm";
    rerender();
  });

  return select;
}

function buildTextInput(
  renderer: CliRenderer,
  state: WizardState,
  rerender: () => void,
): BoxRenderable {
  const field = getCurrentField(state.step);
  const box = new BoxRenderable(renderer, {
    id: "input-box",
    width: "100%",
    height: 6,
    border: true,
    borderStyle: "rounded",
    borderColor: "#334155",
    padding: 1,
    flexDirection: "column",
    gap: 1,
  });

  box.add(
    new TextRenderable(renderer, {
      id: "prompt",
      content: field.prompt,
      fg: "#e2e8f0",
      attributes: TextAttributes.BOLD,
    }),
  );

  const input = new InputRenderable(renderer, {
    id: "control",
    width: "100%",
    value: getStateValue(state, field.key) || field.defaultValue,
    placeholder: field.defaultValue,
    backgroundColor: "#0f172a",
    focusedBackgroundColor: "#111827",
    textColor: "#e5e7eb",
    cursorColor: "#7dd3fc",
  });

  input.on(InputRenderableEvents.ENTER, () => {
    const value = input.value.trim() || field.defaultValue;
    setStateValue(state, field.key, value);
    if (state.step === "profile") {
      detectConsumoProfile(state);
    }
    state.step = nextStep(state.step, state);
    rerender();
  });

  box.add(input);
  return box;
}

function buildConfirmSelect(
  renderer: CliRenderer,
  state: WizardState,
  rerender: () => void,
  finish: () => void,
  dependencies: InteractiveMigrationDependencies,
): SelectRenderable {
  const select = new SelectRenderable(renderer, {
    id: "control",
    width: "100%",
    height: 8,
    showDescription: true,
    options: [
      {
        name: "Rodar agora",
        description: "Prepara o plano redigido e abre a revisao dentro da TUI.",
        value: "run",
      },
      {
        name: "Voltar",
        description: "Revisar os caminhos antes de rodar.",
        value: "back",
      },
      {
        name: "Cancelar",
        description: "Fecha a TUI sem gerar novos artefatos.",
        value: "cancel",
      },
    ],
    selectedIndex: 0,
    selectedBackgroundColor: "#164e63",
    selectedTextColor: "#ffffff",
  });

  select.on(SelectRenderableEvents.ITEM_SELECTED, async (_index, option) => {
    if (option.value === "cancel") {
      finish();
      return;
    }

    if (option.value === "back") {
      state.step = state.mode === "execute-dev" ? "envFile" : "mode";
      rerender();
      return;
    }

    await runSelectedMigration(renderer, state, rerender, finish, dependencies);
  });

  return select;
}

async function runSelectedMigration(
  renderer: CliRenderer,
  state: WizardState,
  rerender: () => void,
  finish: () => void,
  dependencies: InteractiveMigrationDependencies,
): Promise<void> {
  renderStatus(
    renderer,
    "Preparando plano redigido...",
    getPrepareStatusMessage(state.mode),
  );

  try {
    const options = buildInteractiveOptions(state as InteractiveAnswers);
    options.onProgress = (event) => {
      renderStatus(renderer, "Progresso da migracao", `${event.message}\n\nFase: ${event.phase}`);
    };
    const prepared = await dependencies.prepareMigrationPlan(options);
    let preflightReport: TetraDevPreflightReport | undefined;
    let consumoPreflightReport: ConsumoPreflightReport | undefined;
    if (options.preflightDev) {
      if (isConsumoPrepared(prepared)) {
        consumoPreflightReport = await (dependencies.preflightConsumoPlan ?? preflightConsumoPlan)(
          prepared,
          options,
        );
      } else {
        preflightReport = await dependencies.preflightPreparedMigrationPlan(prepared, options);
      }
    }
    renderPlanReview(
      renderer,
      prepared,
      options,
      rerender,
      finish,
      dependencies,
      preflightReport,
      consumoPreflightReport,
    );
    return;
  } catch (error) {
    renderStatus(
      renderer,
      "Erro",
      `${error instanceof Error ? error.message : String(error)}\n\nPressione ESC para sair.`,
    );
  }

  renderer.keyInput.once("keypress", (key) => {
    if (key.name === "escape" || key.name === "enter" || key.name === "return") {
      finish();
    }
  });
}

function renderPlanReview(
  renderer: CliRenderer,
  prepared: MigrationPrepareResult,
  options: MigrationCliOptions,
  rerender: () => void,
  finish: () => void,
  dependencies: InteractiveMigrationDependencies,
  preflightReport?: TetraDevPreflightReport,
  consumoPreflightReport?: ConsumoPreflightReport,
): void {
  replaceScreen(renderer);

  const screen = new BoxRenderable(renderer, {
    id: "screen",
    width: "100%",
    height: "100%",
    padding: 1,
    flexDirection: "column",
    gap: 1,
  });

  screen.add(
    new TextRenderable(renderer, {
      id: "plan-title",
      content: "Revisao do plano",
      fg: "#7dd3fc",
      attributes: TextAttributes.BOLD,
    }),
  );
  screen.add(
    new TextRenderable(renderer, {
      id: "plan-subtitle",
      content: options.execute
        ? `Revise o plano abaixo. O ${getModeLabelFromOptions(options)} so roda se voce confirmar nesta tela.`
        : "Dry-run concluido. O plano redigido esta visivel abaixo.",
      fg: "#cbd5e1",
    }),
  );

  const planBox = new ScrollBoxRenderable(renderer, {
    id: "plan-scroll",
    width: "100%",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: "#334155",
    padding: 1,
    scrollY: true,
    scrollX: false,
  });
  planBox.add(
    new TextRenderable(renderer, {
      id: "plan-body",
      content: buildPlanReviewText(prepared, options, preflightReport, consumoPreflightReport),
      fg: "#e5e7eb",
    }),
  );
  screen.add(planBox);

  const select = new SelectRenderable(renderer, {
    id: "control",
    width: "100%",
    height: options.execute ? 9 : 7,
    showDescription: true,
    options: options.execute
      ? [
          {
            name: options.adapter === "tetra-dev" ? "Executar dev agora" : "Executar fake agora",
            description:
              options.adapter === "tetra-dev"
                ? "Executa o plano exibido acima contra os servicos Tetra dev configurados."
                : "Executa o plano exibido acima apenas no adaptador fake local.",
            value: "execute",
          },
          {
            name: "Finalizar sem executar",
            description: "Mantem o dry-run gravado e fecha a TUI.",
            value: "finish",
          },
          {
            name: "Voltar",
            description: "Revisar caminhos e gerar outro plano.",
            value: "back",
          },
        ]
      : [
          {
            name: "Finalizar dry-run",
            description: "Fecha a TUI mantendo o plano e ledger redigidos.",
            value: "finish",
          },
          {
            name: "Voltar",
            description: "Revisar caminhos e gerar outro plano.",
            value: "back",
          },
        ],
    selectedIndex: 0,
    selectedBackgroundColor: "#164e63",
    selectedTextColor: "#ffffff",
  });

  select.on(SelectRenderableEvents.ITEM_SELECTED, async (_index, option) => {
    if (option.value === "finish") {
      finish();
      return;
    }

    if (option.value === "back") {
      rerender();
      return;
    }

    await executeReviewedPlan(renderer, prepared, options, finish, dependencies);
  });

  screen.add(select);
  renderer.root.add(screen);
  screen.findDescendantById("control")?.focus();
  renderer.requestRender();
}

async function executeReviewedPlan(
  renderer: CliRenderer,
  prepared: MigrationPrepareResult,
  options: MigrationCliOptions,
  finish: () => void,
  dependencies: InteractiveMigrationDependencies,
): Promise<void> {
  renderStatus(renderer, "Executando plano revisado...", getExecuteStatusMessage(options));

  try {
    const result = await dependencies.executePreparedMigrationPlan(prepared, options);
    renderExecutionComplete(renderer, prepared, result, finish);
  } catch (error) {
    renderStatus(
      renderer,
      "Erro",
      `${error instanceof Error ? error.message : String(error)}\n\nPressione ESC para sair.`,
    );
    renderer.keyInput.once("keypress", (key) => {
      if (key.name === "escape" || key.name === "enter" || key.name === "return") {
        finish();
      }
    });
  }
}

function renderExecutionComplete(
  renderer: CliRenderer,
  prepared: MigrationPrepareResult,
  result: MigrationExecuteResult,
  finish: () => void,
): void {
  renderStatus(renderer, "Concluido", buildExecutionCompleteText(prepared, result));
  renderer.keyInput.once("keypress", (key) => {
    if (key.name === "escape" || key.name === "enter" || key.name === "return") {
      finish();
    }
  });
}

export function buildExecutionCompleteText(
  prepared: MigrationPrepareResult,
  result: MigrationExecuteResult,
): string {
  const lines = [
    `Execute ${result.executeSummary.adapter} concluido`,
    `Run: ${prepared.plan.runId}`,
    `Adapter: ${result.executeSummary.adapter}`,
    `Operacoes tentadas: ${result.executeSummary.attemptedOperations}`,
    `Operacoes com sucesso: ${result.executeSummary.succeededOperations}`,
    `Bloqueios ignorados: ${result.executeSummary.skippedBlockedRows}`,
    "",
    "Artefatos redigidos",
    `Plano JSON: ${prepared.planPath}`,
    `Relatorio execute: ${result.executeReportPath}`,
    "",
    "Plano executado",
    formatAnyPlanForTui(prepared.plan),
    "",
    "Pressione ESC para sair.",
  ];

  return lines.join("\n");
}

export function buildPlanReviewText(
  prepared: MigrationPrepareResult,
  options: MigrationCliOptions,
  preflightReport?: TetraDevPreflightReport,
  consumoPreflightReport?: ConsumoPreflightReport,
): string {
  const lines = [
    formatAnyPlanForTui(prepared.plan),
    "",
    "Artefatos redigidos",
    `Plano JSON: ${prepared.planPath}`,
    `Ledger SQLite: ${options.ledger}`,
  ];

  if (options.execute) {
    lines.push(`Relatorio execute previsto: ${options.executeReport}`);
  }

  if (consumoPreflightReport) {
    lines.push(
      "",
      "Preflight tetra-dev (consumo)",
      `Checks ok: ${consumoPreflightReport.summary.ok} | avisos: ${consumoPreflightReport.summary.warnings} | falhas: ${consumoPreflightReport.summary.failures}`,
      ...consumoPreflightReport.checks.map(
        (check) => `[${check.status}] ${check.check}: ${check.detail}`,
      ),
    );
  }

  if (preflightReport) {
    lines.push(
      "",
      "Preflight tetra-dev",
      `Operacoes checadas: ${preflightReport.summary.checkedOperations}`,
      `Operacoes prontas: ${preflightReport.summary.readyOperations}`,
      `Falhas de alvo: ${preflightReport.summary.failedOperations}`,
      `Linhas bloqueadas mantidas fora do execute: ${preflightReport.summary.blockedRows}`,
      ...formatPreflightFailures(preflightReport),
    );
  }

  return lines.join("\n");
}

function formatPreflightFailures(preflightReport: TetraDevPreflightReport): string[] {
  const failures = preflightReport.results.filter((result) => result.status === "failed");
  if (failures.length === 0) {
    return ["Alvos validados: sim"];
  }

  return failures.map(
    (failure) =>
      `Alvo invalido: ${failure.operationId} grupo=${failure.accessGroupId} produto=${failure.productId} erro=${failure.errorCode}`,
  );
}

function renderStatus(renderer: CliRenderer, title: string, content: string): void {
  replaceScreen(renderer);

  const screen = new BoxRenderable(renderer, {
    id: "screen",
    width: "100%",
    height: "100%",
    padding: 1,
    flexDirection: "column",
    gap: 1,
  });
  screen.add(
    new TextRenderable(renderer, {
      id: "status-title",
      content: title,
      fg: title === "Erro" ? "#fca5a5" : "#86efac",
      attributes: TextAttributes.BOLD,
    }),
  );
  screen.add(
    new TextRenderable(renderer, {
      id: "status-body",
      content,
      fg: "#e5e7eb",
    }),
  );
  renderer.root.add(screen);
  renderer.requestRender();
}

function replaceScreen(renderer: CliRenderer): void {
  if (renderer.root.getRenderable("screen")) {
    renderer.root.remove("screen");
  }
}

function getCurrentField(step: WizardStep): {
  key: keyof Pick<
    InteractiveAnswers,
    "input" | "profile" | "envFile" | "startsAt" | "periodicityValue"
  >;
  prompt: string;
  defaultValue: string;
} {
  if (step === "input") {
    return {
      key: "input",
      prompt: "Planilha local CSV/XLSX (abs/relativo, ~, aspas, espacos)",
      defaultValue: DEFAULT_INPUT,
    };
  }
  if (step === "profile") {
    return {
      key: "profile",
      prompt: "Caminho do perfil de mapeamento aprovado",
      defaultValue: DEFAULT_PROFILE,
    };
  }

  if (step === "startsAt") {
    return {
      key: "startsAt",
      prompt: "Inicio da matricula desta planilha (YYYY-MM-DD, America/Sao_Paulo)",
      defaultValue: "",
    };
  }

  if (step === "periodicityValue") {
    return {
      key: "periodicityValue",
      prompt: "Multiplicador da periodicidade (ex.: 1 = 1 ano/mes/dia)",
      defaultValue: "1",
    };
  }

  if (step === "envFile") {
    return {
      key: "envFile",
      prompt: "Env-file local opcional para tetra-dev (ENTER usa process.env)",
      defaultValue: "",
    };
  }

  return {
    key: "input",
    prompt: "Planilha local CSV/XLSX (abs/relativo, ~, aspas, espacos)",
    defaultValue: DEFAULT_INPUT,
  };
}

function nextStep(step: WizardStep, state: WizardState): WizardStep {
  if (step === "input") return "profile";
  if (step === "profile") return state.isConsumoProfile ? "startsAt" : "mode";
  if (step === "startsAt") return "periodicity";
  if (step === "periodicity") return "periodicityValue";
  if (step === "periodicityValue") return "catalog";
  if (step === "catalog") return "mode";
  if (step === "envFile") return "confirm";
  return "confirm";
}

function buildPeriodicitySelect(
  renderer: CliRenderer,
  state: WizardState,
  rerender: () => void,
): SelectRenderable {
  const values: Array<"YEARLY" | "MONTHLY" | "DAILY"> = ["YEARLY", "MONTHLY", "DAILY"];
  const select = new SelectRenderable(renderer, {
    id: "control",
    width: "100%",
    height: 6,
    showDescription: true,
    options: [
      {
        name: "Anual (YEARLY)",
        description: "A matricula expira N ano(s) depois do inicio informado.",
        value: "YEARLY",
      },
      {
        name: "Mensal (MONTHLY)",
        description: "A matricula expira N mes(es) depois do inicio informado.",
        value: "MONTHLY",
      },
      {
        name: "Diaria (DAILY)",
        description: "A matricula expira N dia(s) depois do inicio informado.",
        value: "DAILY",
      },
    ],
    selectedIndex: Math.max(0, values.indexOf(state.periodicity ?? "YEARLY")),
    selectedBackgroundColor: "#164e63",
    selectedTextColor: "#ffffff",
  });

  select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    state.periodicity = option.value as "YEARLY" | "MONTHLY" | "DAILY";
    state.step = nextStep("periodicity", state);
    rerender();
  });

  return select;
}

function buildCatalogSelect(
  renderer: CliRenderer,
  state: WizardState,
  rerender: () => void,
): SelectRenderable {
  const select = new SelectRenderable(renderer, {
    id: "control",
    width: "100%",
    height: 5,
    showDescription: true,
    options: [
      {
        name: "Usar catalog map local",
        description: "Resolve cursos/aulas pelo arquivo apontado no perfil, sem chamar APIs.",
        value: "local",
      },
      {
        name: "Sincronizar do tetra-products agora",
        description: "Chama a rota interna de catalogo (exige env dev) e regrava o mapa local.",
        value: "sync",
      },
    ],
    selectedIndex: state.syncCatalog ? 1 : 0,
    selectedBackgroundColor: "#164e63",
    selectedTextColor: "#ffffff",
  });

  select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    state.syncCatalog = option.value === "sync";
    state.step = nextStep("catalog", state);
    rerender();
  });

  return select;
}

function getModeLabel(mode: InteractiveMode | undefined): string {
  if (mode === "execute-dev") return "execute dev";
  if (mode === "execute-fake") return "execute fake";
  return "dry-run";
}

function getModeLabelFromOptions(options: MigrationCliOptions): string {
  return options.adapter === "tetra-dev" ? "execute dev" : "execute fake";
}

function getPrepareStatusMessage(mode: InteractiveMode | undefined): string {
  if (mode === "execute-dev") {
    return "Lendo a planilha e montando o plano local. APIs Tetra dev so serao chamadas se voce confirmar depois da revisao inline.";
  }

  return "Lendo a planilha e montando o plano local. Nenhuma API real da Tetra sera chamada nesta etapa.";
}

function getExecuteStatusMessage(options: MigrationCliOptions): string {
  if (options.adapter === "tetra-dev") {
    return "Executando o adapter tetra-dev com as credenciais locais configuradas.";
  }

  return "Executando somente o adaptador fake local para o plano que esta na tela.";
}

function getStateValue(
  state: WizardState,
  key: keyof Pick<
    InteractiveAnswers,
    "input" | "profile" | "envFile" | "startsAt" | "periodicityValue"
  >,
): string | undefined {
  return state[key];
}

function setStateValue(
  state: WizardState,
  key: keyof Pick<
    InteractiveAnswers,
    "input" | "profile" | "envFile" | "startsAt" | "periodicityValue"
  >,
  value: string,
): void {
  state[key] = value;
}
