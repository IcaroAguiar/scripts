import fs from 'fs-extra';
import path from 'node:path';

export const DEFAULT_PRODUCTS_JSON_PATH = 'trilhas_cursos_com_panda_novo.json';

interface ProductMappingFile {
  trilhas?: Array<{
    products?: ProductMappingEntry[];
  }>;
}

interface ProductMappingEntry {
  name?: string;
  lessons?: Array<{ name?: string }>;
  modules?: Array<{
    lessons?: Array<{ name?: string }>;
  }>;
}

function normalizedWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeProductName(value: string): string {
  return normalizedWhitespace(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function parseProductsArg(argv: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;

    if (token === '--products') {
      const raw = argv[i + 1] ?? '';
      if (raw) values.push(raw);
      i += 1;
      continue;
    }

    if (token.startsWith('--products=')) {
      values.push(token.slice('--products='.length));
    }
  }

  return values
    .flatMap((chunk) => chunk.split(','))
    .map((item) => normalizedWhitespace(item))
    .filter(Boolean);
}

export async function loadProductsFromJson(
  jsonPath = DEFAULT_PRODUCTS_JSON_PATH
): Promise<{ products: string[]; sourcePath: string }> {
  const absolutePath = path.resolve(process.cwd(), jsonPath);
  const payload = (await fs.readJson(absolutePath)) as ProductMappingFile;

  const names = (payload.trilhas ?? [])
    .flatMap((trilha) => trilha.products ?? [])
    .map((product) => normalizedWhitespace(product.name ?? ''))
    .filter(Boolean);

  const deduped = Array.from(new Set(names));
  return { products: deduped, sourcePath: absolutePath };
}

function collectProductLessonNames(product: ProductMappingEntry): string[] {
  const topLevelLessons = (product.lessons ?? [])
    .map((lesson) => normalizedWhitespace(lesson.name ?? ''))
    .filter(Boolean);
  const moduleLessons = (product.modules ?? [])
    .flatMap((mod) => mod.lessons ?? [])
    .map((lesson) => normalizedWhitespace(lesson.name ?? ''))
    .filter(Boolean);

  return [...topLevelLessons, ...moduleLessons];
}

export async function loadProductLessonNameMapFromJson(
  jsonPath = DEFAULT_PRODUCTS_JSON_PATH
): Promise<{ lessonNamesByProductKey: Map<string, string[]>; sourcePath: string }> {
  const absolutePath = path.resolve(process.cwd(), jsonPath);
  const payload = (await fs.readJson(absolutePath)) as ProductMappingFile;
  const lessonNamesByProductKey = new Map<string, string[]>();

  for (const trilha of payload.trilhas ?? []) {
    for (const product of trilha.products ?? []) {
      const productName = normalizedWhitespace(product.name ?? '');
      if (!productName) continue;
      const productKey = normalizeProductName(productName);
      if (!productKey || lessonNamesByProductKey.has(productKey)) continue;
      lessonNamesByProductKey.set(productKey, collectProductLessonNames(product));
    }
  }

  return { lessonNamesByProductKey, sourcePath: absolutePath };
}

export function filterCoursesByProducts<T extends { name: string }>(
  courses: T[],
  targetProducts: string[]
): {
  filteredCourses: T[];
  missingProducts: string[];
} {
  const courseByKey = new Map<string, T>();
  for (const course of courses) {
    const key = normalizeProductName(course.name);
    if (!courseByKey.has(key)) courseByKey.set(key, course);
  }

  const filteredCourses: T[] = [];
  const missingProducts: string[] = [];
  const selectedKeys = new Set<string>();

  for (const product of targetProducts) {
    const key = normalizeProductName(product);
    if (!key || selectedKeys.has(key)) continue;
    selectedKeys.add(key);

    const matched = courseByKey.get(key);
    if (matched) {
      filteredCourses.push(matched);
      continue;
    }

    missingProducts.push(product);
  }

  return { filteredCourses, missingProducts };
}
