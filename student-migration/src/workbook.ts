import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import ExcelJS from "exceljs";
import { parseCsv, type CsvRow } from "./csv";
import { csvRowsToSourceRows, type SourceRow } from "./migration-plan";

export async function readWorkbook(path: string): Promise<SourceRow[]> {
  const extension = extname(path).toLowerCase();

  if (extension === ".csv") {
    const csv = await readFile(path, "utf8");
    return csvRowsToSourceRows(parseCsv(csv), "csv");
  }

  if (extension === ".xlsx") {
    const buffer = await readFile(path);
    return xlsxBufferToSourceRows(buffer);
  }

  throw new Error("Unsupported input format. Use .csv or .xlsx.");
}

/** Le a primeira aba de um .xlsx como matriz posicional de textos. */
export async function readWorkbookMatrix(path: string): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  const buffer = await readFile(path);
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(`Workbook has no worksheets: ${path}`);
  }

  const matrix: string[][] = [];
  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values: string[] = [];
    for (let columnIndex = 1; columnIndex <= row.cellCount; columnIndex += 1) {
      values[columnIndex - 1] = row.getCell(columnIndex).text.trim();
    }
    matrix[rowNumber - 1] = values;
  });

  return matrix.map((row) => row ?? []);
}

async function xlsxBufferToSourceRows(buffer: Buffer): Promise<SourceRow[]> {
  const workbook = new ExcelJS.Workbook();
  const excelBuffer = buffer as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(excelBuffer);
  const rows: SourceRow[] = [];

  for (const worksheet of workbook.worksheets) {
    const headers = readHeaderRow(worksheet);
    if (headers.length === 0) continue;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;

      rows.push({
        sheetName: worksheet.name,
        rowNumber,
        values: rowToCsvRow(row, headers),
      });
    });
  }

  return rows;
}

function readHeaderRow(worksheet: ExcelJS.Worksheet): string[] {
  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];

  for (let columnIndex = 1; columnIndex <= headerRow.cellCount; columnIndex += 1) {
    const header = headerRow.getCell(columnIndex).text.trim();
    if (header) {
      headers[columnIndex - 1] = header;
    }
  }

  return headers;
}

function rowToCsvRow(row: ExcelJS.Row, headers: string[]): CsvRow {
  const values: CsvRow = {};

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (!header) continue;

    values[header] = row.getCell(index + 1).text.trim();
  }

  return values;
}
