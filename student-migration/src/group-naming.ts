// Normalizacao de nomes de produtos TheMembers para grupos de acesso de
// migracao. Regras acordadas: remover ruido de gateway/CNPJ, preservar a
// periodicidade no nome, sufixar "- migracao" e consolidar nomes iguais.

export type GroupPeriodicity = {
  periodicity: "DAILY" | "MONTHLY" | "YEARLY";
  periodicityValue: number;
};

export type PeriodicityParse =
  | { status: "parsed"; value: GroupPeriodicity }
  | { status: "none" }
  | { status: "lifetime" }
  | { status: "conflicting"; detail: string };

export type GroupType = "tetra-club" | "pos" | "mba";

export type ProductClassification =
  | { status: "in-scope"; type: GroupType }
  | { status: "excluded"; reason: string }
  | { status: "ambiguous"; reason: string }
  | { status: "out-of-scope" };

export const MIGRATION_SUFFIX = "migracao";

// Sufixos de gateway/canal observados no export real. So removidos quando
// aparecem como token final isolado, para nao mutilar nomes legitimos.
const GATEWAY_SUFFIX_TOKENS = new Set(["as", "asaas", "p", "on", "m", "r", "mp", "a", "pg", "b", "si", "site", "guru", "eduzz", "pagarme"]);

const CNPJ_PATTERN = /CNPJ:?\s*[\d./-]+/gi;
const MIGRATION_TOKEN_PATTERN = /\(?\s*migra[cç][aã]o\s*\)?/gi;

// Decisao 2026-07-07: produtos que NAO viram grupo de acesso (a taxa e um
// artefato de cobranca; ferramentas entram nos grupos como produtos).
const EXCLUDED_PRODUCT_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^taxa de matricula/, reason: "taxa de matricula nao vira grupo de acesso" },
  {
    pattern: /^ferramentas tetra club/,
    reason: "ferramentas sao adicionadas aos grupos como produtos, nao como grupo proprio",
  },
];

// Decisao 2026-07-07: overrides pontuais de periodicidade por nome.
const PERIODICITY_OVERRIDES: Array<{ pattern: RegExp; value: GroupPeriodicity }> = [
  {
    // "sem 10 anos" = versao da Pos sem o Tetra Club de 10 anos; acesso 18 meses.
    pattern: /pos-graduacao gestao,? negocios e ia - sem 10 anos/,
    value: { periodicity: "MONTHLY", periodicityValue: 18 },
  },
];

export function stripDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function comparableName(value: string): string {
  return stripDiacritics(value).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Limpa o nome cru do TheMembers e aplica o sufixo de migracao.
 * Nomes distintos que ficarem iguais apos a limpeza consolidam em um grupo.
 */
export function normalizeGroupName(rawName: string): string {
  let name = rawName.replace(/\s+/g, " ").trim();

  name = name.replace(CNPJ_PATTERN, " ");
  name = name.replace(MIGRATION_TOKEN_PATTERN, " ");
  // Residuos de parcelamento colados ao CNPJ removido: "Parcelado 18X 165,00".
  name = name.replace(/Parcelado\s+\d+X[\s\d.,]*/gi, " ");
  // Grafia canonica da marca: "TetraClub"/"tetra club" -> "Tetra Club".
  name = name.replace(/tetra\s*club/gi, "Tetra Club");

  // Prefixos de canal: "-", "_", "on -" no inicio.
  name = name.replace(/^[\s\-_|]+/, "");
  name = name.replace(/^on\s*-\s*/i, "");
  name = name.replace(/^\+\s*/, "");

  // Sufixos de gateway como token final, possivelmente repetidos.
  let changed = true;
  while (changed) {
    changed = false;
    const next = name.replace(/[\s\-|]+$/g, "");
    const match = next.match(/^(.*?)[\s]*[-|][\s]*([A-Za-z]{1,8})$/);
    if (match && GATEWAY_SUFFIX_TOKENS.has(match[2]!.toLowerCase())) {
      name = match[1]!;
      changed = true;
      continue;
    }
    // Sufixo de gateway apos colchete: "[Extensao Universitaria] on".
    const bracket = next.match(/^(.*\])\s+([A-Za-z]{1,8})$/);
    if (bracket && GATEWAY_SUFFIX_TOKENS.has(bracket[2]!.toLowerCase())) {
      name = bracket[1]!;
      changed = true;
      continue;
    }
    name = next;
  }

  name = name.replace(/\s+/g, " ").replace(/[\s\-|]+$/g, "").trim();
  return `${name} - ${MIGRATION_SUFFIX}`;
}

/**
 * Chave de consolidacao: dois nomes crus com a mesma chave viram um grupo.
 * Ignora pontuacao (virgulas/typos de digitacao) e expande "Tetra Club N"
 * para "Tetra Club N anos" (decisao 2026-07-07) para fundir variantes.
 */
export function groupKeyForName(rawName: string): string {
  return comparableName(normalizeGroupName(rawName))
    .replace(/[,.:;]/g, "")
    .replace(/tetra club (\d{1,2})\b(?!\s*(ano|mes|dia))/, "tetra club $1 anos")
    .replace(/\s+/g, " ")
    .trim();
}

const YEAR_PATTERN = /(\d+)\s*ano/i;
const MONTH_PATTERN = /(\d+)\s*m[eê]s/i;
const DAY_PATTERN = /(\d+)\s*dia/i;

export function parsePeriodicityFromName(rawName: string): PeriodicityParse {
  const name = comparableName(rawName);

  for (const override of PERIODICITY_OVERRIDES) {
    if (override.pattern.test(name)) {
      return { status: "parsed", value: override.value };
    }
  }

  const lifetime = /vitalicio/.test(name);
  const trial = /trial|gratuito|teste/.test(name);

  const matches: GroupPeriodicity[] = [];
  const year = name.match(YEAR_PATTERN);
  if (year) matches.push({ periodicity: "YEARLY", periodicityValue: Number(year[1]) });
  const month = name.match(MONTH_PATTERN);
  if (month) matches.push({ periodicity: "MONTHLY", periodicityValue: Number(month[1]) });
  const day = name.match(DAY_PATTERN);
  if (day) matches.push({ periodicity: "DAILY", periodicityValue: Number(day[1]) });
  if (matches.length === 0 && /\banual\b/.test(name)) {
    matches.push({ periodicity: "YEARLY", periodicityValue: 1 });
  }
  // Decisao 2026-07-07: numero solto apos "Tetra Club" (ex.: "Tetra Club 10")
  // significa anos de acesso.
  if (matches.length === 0) {
    const bare = name.match(/tetra\s*club\s+(\d{1,2})\b(?!\s*(ano|mes|dia|x|%))/);
    if (bare) {
      matches.push({ periodicity: "YEARLY", periodicityValue: Number(bare[1]) });
    }
  }

  if (lifetime && matches.length > 0) {
    return {
      status: "conflicting",
      detail: `nome menciona vitalicio e tambem ${describePeriodicity(matches[0]!)}`,
    };
  }
  if (lifetime) {
    return { status: "lifetime" };
  }
  if (matches.length > 1) {
    return {
      status: "conflicting",
      detail: `nome menciona multiplas periodicidades: ${matches.map(describePeriodicity).join(", ")}`,
    };
  }
  if (matches.length === 1) {
    // Menções de trial/teste junto de uma periodicidade curta são aceitas
    // (ex.: "Trial 7 Dias"); o grupo carrega a periodicidade literal.
    return { status: "parsed", value: matches[0]! };
  }
  if (trial) {
    return { status: "conflicting", detail: "nome menciona trial/gratuito sem duracao clara" };
  }
  return { status: "none" };
}

export function describePeriodicity(value: GroupPeriodicity): string {
  const unit =
    value.periodicity === "YEARLY" ? "ano(s)" : value.periodicity === "MONTHLY" ? "mes(es)" : "dia(s)";
  return `${value.periodicityValue} ${unit}`;
}

/**
 * Classifica um produto TheMembers em um dos 3 tipos do xlsx.
 * Decisao 2026-07-07: qualquer produto com "Tetra Club" no nome (que nao seja
 * MBA/Pos) libera os cursos da coluna Tetra Club, incluindo combos
 * "Formacao X + Tetra Club".
 */
export function classifyProduct(rawName: string): ProductClassification {
  const name = comparableName(rawName);

  for (const rule of EXCLUDED_PRODUCT_RULES) {
    if (rule.pattern.test(name)) {
      return { status: "excluded", reason: rule.reason };
    }
  }

  if (/\bmba\b/.test(name)) {
    return { status: "in-scope", type: "mba" };
  }
  if (/pos[\s-]?graduacao/.test(name)) {
    return { status: "in-scope", type: "pos" };
  }
  if (/tetra\s*club/.test(name)) {
    return { status: "in-scope", type: "tetra-club" };
  }
  return { status: "out-of-scope" };
}

// Tokens sem significado de acesso em nomes "Tetra Club puro". Qualificadores
// reais (lideranca, corporativo, empresarial, trial, bonus, recorrente, nomes
// de empresa...) NAO estao aqui de proposito: mantem o grupo separado.
const PURE_TC_FILLER_TOKENS = new Set(["tetra", "club", "acesso", "com", "de", "estendido", "para"]);

/**
 * Deduplicacao canonica (decisao 2026-07-07): variantes de "Tetra Club puro"
 * que diferem so por formatacao ("Acesso 4 anos", "COM ACESSO DE 4 ANOS",
 * "estendido para 4 anos", "Tetra Club 4 Anos") consolidam em um unico grupo
 * canonico "Tetra Club - Acesso N anos - migracao". Retorna undefined quando
 * o nome carrega qualificadores reais (Lideranca, Corporativo, Trial, etc.).
 */
export function canonicalTetraClubName(rawName: string): string | undefined {
  const normalized = normalizeGroupName(rawName);
  const base = normalized.slice(0, -` - ${MIGRATION_SUFFIX}`.length);

  const stripped = comparableName(base)
    .replace(/[,.:;|_-]/g, " ")
    .replace(/\d+\s*(anos?|mes(es)?|dias?)/g, " ")
    .replace(/vitalicio/g, " ")
    .replace(/\banual\b/g, " ");
  const tokens = stripped.split(/\s+/).filter(Boolean);

  const hasBrand = tokens.includes("tetra") && tokens.includes("club");
  const isPure = hasBrand && tokens.every((token) => PURE_TC_FILLER_TOKENS.has(token) || /^\d{1,2}$/.test(token));
  if (!isPure) {
    return undefined;
  }

  const periodicity = parsePeriodicityFromName(rawName);
  if (periodicity.status === "parsed") {
    return `Tetra Club - Acesso ${describeCanonicalPeriod(periodicity.value)} - ${MIGRATION_SUFFIX}`;
  }
  if (periodicity.status === "lifetime") {
    return `Tetra Club - Acesso Vitalício - ${MIGRATION_SUFFIX}`;
  }
  if (periodicity.status === "none") {
    return `Tetra Club - ${MIGRATION_SUFFIX}`;
  }
  // Conflito de periodicidade continua fora da deduplicacao canonica.
  return undefined;
}

function describeCanonicalPeriod(value: GroupPeriodicity): string {
  const plural = value.periodicityValue > 1;
  const unit =
    value.periodicity === "YEARLY"
      ? plural ? "anos" : "ano"
      : value.periodicity === "MONTHLY"
        ? plural ? "meses" : "mês"
        : plural ? "dias" : "dia";
  return `${value.periodicityValue} ${unit}`;
}
