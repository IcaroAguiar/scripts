// Leitor do export de alunos/assinaturas do TheMembers.
//
// O arquivo real e um re-export de Excel de um CSV `;`-delimitado: cada linha
// logica foi tratada como UMA celula (aspas externas, `""` internos) e nomes
// de produto contendo virgula foram quebrados em MULTIPLAS celulas externas.
// A reconstrucao rejunta as celulas nao-vazias com "," antes do parse por `;`.

export const THEMEMBERS_PRODUCTS_HEADERS = [
  "user_id",
  "user_name",
  "user_email",
  "document",
  "phone",
  "product_id",
  "product_name",
  "user_subscription_created_at",
] as const;

export type TheMembersSubscriptionRow = {
  userId: string;
  userName: string;
  userEmail: string;
  document: string;
  phone: string;
  productId: string;
  productName: string;
  subscriptionCreatedAt: string;
};

export type ProductAggregate = {
  productId: string;
  productName: string;
  studentCount: number;
  /** Nomes divergentes vistos para o mesmo product_id (alem do canonico). */
  conflictingNames: string[];
};

export type TheMembersProductsFile = {
  rows: TheMembersSubscriptionRow[];
  products: ProductAggregate[];
  skippedLines: Array<{ lineNumber: number; reason: string }>;
  encoding: "utf-8" | "windows-1252";
};

export async function readTheMembersProductsFile(path: string): Promise<TheMembersProductsFile> {
  const buffer = new Uint8Array(await Bun.file(path).arrayBuffer());
  const { text, encoding } = decodeBuffer(buffer);
  return parseTheMembersProducts(text, encoding);
}

export function parseTheMembersProducts(
  text: string,
  encoding: TheMembersProductsFile["encoding"] = "utf-8",
): TheMembersProductsFile {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) {
    throw new Error("TheMembers products file is empty.");
  }

  const headerFields = reconstructLine(lines[0]!)
    .split(";")
    .map((field) => field.trim().toLowerCase());
  const expected = THEMEMBERS_PRODUCTS_HEADERS.join(";");
  if (headerFields.join(";") !== expected) {
    throw new Error(
      `Unexpected TheMembers products header. Expected "${expected}", got "${headerFields.join(";")}".`,
    );
  }

  const rows: TheMembersSubscriptionRow[] = [];
  const skippedLines: TheMembersProductsFile["skippedLines"] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (!raw.trim() || /^,*$/.test(raw.trim())) {
      continue;
    }

    const logical = reconstructLine(raw);
    const fields = splitSemicolonQuoteAware(logical);
    if (fields.length !== THEMEMBERS_PRODUCTS_HEADERS.length) {
      skippedLines.push({
        lineNumber: index + 1,
        reason: `expected ${THEMEMBERS_PRODUCTS_HEADERS.length} fields, got ${fields.length}`,
      });
      continue;
    }

    const [userId, userName, userEmail, document, phone, productId, productName, createdAt] =
      fields as [string, string, string, string, string, string, string, string];
    if (!productId || !productName) {
      skippedLines.push({ lineNumber: index + 1, reason: "missing product_id or product_name" });
      continue;
    }

    rows.push({
      userId,
      userName,
      userEmail,
      document,
      phone,
      productId,
      productName,
      subscriptionCreatedAt: createdAt,
    });
  }

  return { rows, products: aggregateProducts(rows), skippedLines, encoding };
}

function aggregateProducts(rows: TheMembersSubscriptionRow[]): ProductAggregate[] {
  const byId = new Map<string, ProductAggregate>();

  for (const row of rows) {
    const existing = byId.get(row.productId);
    if (!existing) {
      byId.set(row.productId, {
        productId: row.productId,
        productName: row.productName,
        studentCount: 1,
        conflictingNames: [],
      });
      continue;
    }

    existing.studentCount += 1;
    if (
      row.productName !== existing.productName &&
      !existing.conflictingNames.includes(row.productName)
    ) {
      existing.conflictingNames.push(row.productName);
    }
  }

  return Array.from(byId.values()).sort((a, b) => b.studentCount - a.studentCount);
}

/**
 * Reconstroi a linha logica: parse CSV padrao por virgula (com unescape de
 * `""` dentro de celulas com aspas) e rejoin das celulas nao-vazias com ",".
 * Linhas simples (uma celula, `,,,` finais) tambem passam por aqui.
 */
export function reconstructLine(rawLine: string): string {
  const cells = splitCommaCsvCells(rawLine.replace(/\r$/, ""));
  while (cells.length > 0 && cells[cells.length - 1] === "") {
    cells.pop();
  }
  return cells.join(",");
}

function splitCommaCsvCells(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current);
  return cells;
}

/**
 * Split por `;` da linha logica ja reconstruida, respeitando aspas
 * remanescentes de campos individuais (`"Nome";" ..."`).
 */
function splitSemicolonQuoteAware(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ";") {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  fields.push(current.trim());
  return fields;
}

function decodeBuffer(buffer: Uint8Array): {
  text: string;
  encoding: TheMembersProductsFile["encoding"];
} {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      encoding: "utf-8",
    };
  } catch {
    return {
      text: new TextDecoder("windows-1252").decode(buffer),
      encoding: "windows-1252",
    };
  }
}
