import { normalizeText } from "./migration-plan";

// Espelho do DTO de GET /internal/catalog/course-map do tetra-products.
export type CatalogMapLesson = {
  lessonId: string;
  lessonTitle: string;
  moduleTitle: string | null;
  order: number;
};

export type CatalogMapProduct = {
  productId: string;
  productTitle: string;
  courseId: string;
  lessons: CatalogMapLesson[];
};

export type CatalogMap = {
  tenantId: string;
  generatedAt: string;
  products: CatalogMapProduct[];
};

export type ResolvedCourseTarget = {
  productId: string;
  productTitle: string;
  courseId: string;
};

export type CourseResolution =
  | { status: "resolved"; target: ResolvedCourseTarget }
  | { status: "unresolved" }
  | { status: "ambiguous" };

export type LessonResolution =
  | { status: "resolved"; lessonId: string }
  | { status: "unresolved" }
  | { status: "ambiguous" };

const KEY_SEPARATOR = "␟";

type TitleEntry<T> = { value: T } | "ambiguous";

export type TitleIndex = {
  courses: Map<string, TitleEntry<ResolvedCourseTarget>>;
  lessonsByModule: Map<string, TitleEntry<string>>;
  lessonsByCourse: Map<string, TitleEntry<string>>;
  ambiguousCourseTitles: string[];
  ambiguousLessonKeys: string[];
};

export function normalizeTitle(value: string): string {
  return normalizeText(value).normalize("NFC").toLowerCase();
}

export function buildTitleIndex(map: CatalogMap): TitleIndex {
  const courses = new Map<string, TitleEntry<ResolvedCourseTarget>>();
  const lessonsByModule = new Map<string, TitleEntry<string>>();
  const lessonsByCourse = new Map<string, TitleEntry<string>>();

  for (const product of map.products) {
    const courseKey = normalizeTitle(product.productTitle);
    addEntry(courses, courseKey, {
      productId: product.productId,
      productTitle: product.productTitle,
      courseId: product.courseId,
    });

    for (const lesson of product.lessons) {
      const moduleKey = [
        courseKey,
        normalizeTitle(lesson.moduleTitle ?? ""),
        normalizeTitle(lesson.lessonTitle),
      ].join(KEY_SEPARATOR);
      addEntry(lessonsByModule, moduleKey, lesson.lessonId);

      const courseLessonKey = [courseKey, normalizeTitle(lesson.lessonTitle)].join(KEY_SEPARATOR);
      addEntry(lessonsByCourse, courseLessonKey, lesson.lessonId);
    }
  }

  return {
    courses,
    lessonsByModule,
    lessonsByCourse,
    ambiguousCourseTitles: collectAmbiguous(courses),
    ambiguousLessonKeys: collectAmbiguous(lessonsByModule),
  };
}

export function resolveCourseByTitle(index: TitleIndex, courseTitle: string): CourseResolution {
  const entry = index.courses.get(normalizeTitle(courseTitle));
  if (!entry) return { status: "unresolved" };
  if (entry === "ambiguous") return { status: "ambiguous" };
  return { status: "resolved", target: entry.value };
}

export function resolveLessonByTitle(
  index: TitleIndex,
  courseTitle: string,
  moduleTitle: string,
  lessonTitle: string,
): LessonResolution {
  const courseKey = normalizeTitle(courseTitle);
  const moduleKey = [courseKey, normalizeTitle(moduleTitle), normalizeTitle(lessonTitle)].join(
    KEY_SEPARATOR,
  );

  const byModule = index.lessonsByModule.get(moduleKey);
  if (byModule && byModule !== "ambiguous") {
    return { status: "resolved", lessonId: byModule.value };
  }
  if (byModule === "ambiguous") {
    return { status: "ambiguous" };
  }

  // Fallback sem modulo: aceito apenas quando o titulo da aula e unico no curso.
  const courseLessonKey = [courseKey, normalizeTitle(lessonTitle)].join(KEY_SEPARATOR);
  const byCourse = index.lessonsByCourse.get(courseLessonKey);
  if (!byCourse) return { status: "unresolved" };
  if (byCourse === "ambiguous") return { status: "ambiguous" };
  return { status: "resolved", lessonId: byCourse.value };
}

export async function loadCatalogMapFromFile(path: string): Promise<CatalogMap> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`catalog map file not found: ${path}`);
  }

  const parsed = (await file.json()) as CatalogMap;
  if (!parsed || !Array.isArray(parsed.products)) {
    throw new Error(`catalog map file is invalid: ${path}`);
  }

  return parsed;
}

export async function writeCatalogMapToFile(path: string, map: CatalogMap): Promise<void> {
  await Bun.write(path, `${JSON.stringify(map, null, 2)}\n`);
}

function addEntry<T>(target: Map<string, TitleEntry<T>>, key: string, value: T): void {
  if (!key) return;
  const existing = target.get(key);
  if (existing === undefined) {
    target.set(key, { value });
    return;
  }

  if (existing !== "ambiguous") {
    const current = JSON.stringify(existing.value);
    if (current === JSON.stringify(value)) {
      return;
    }
  }

  target.set(key, "ambiguous");
}

function collectAmbiguous(target: Map<string, TitleEntry<unknown>>): string[] {
  const keys: string[] = [];
  for (const [key, entry] of target.entries()) {
    if (entry === "ambiguous") keys.push(key);
  }
  return keys.sort();
}
