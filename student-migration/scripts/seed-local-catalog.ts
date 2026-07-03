// Seed local (dev) do catalogo tetra-products a partir da planilha real da
// TheMembers: cria os cursos/modulos/aulas com os titulos exatos no tenant
// local, para o mapeamento por titulo da migracao resolver 100%.
//
// Uso (le DATABASE_URL e o caminho do repo tetra-products por env):
//   TETRA_PRODUCTS_REPO=~/dev/tetra/tetra-services/tetra-products \
//   DATABASE_URL="$(grep '^DATABASE_URL=' $TETRA_PRODUCTS_REPO/.env | cut -d= -f2- | tr -d '\"')" \
//   bun scripts/seed-local-catalog.ts "<planilha.csv>" [tenantId]
//
// Rerunnable: pula cursos que ja existem por titulo no tenant. Somente para
// ambiente local/dev — nunca aponte DATABASE_URL para producao.
import { resolve } from "node:path";

const productsRepo = process.env.TETRA_PRODUCTS_REPO?.replace("~", process.env.HOME ?? "~");
if (!productsRepo) {
  console.error("defina TETRA_PRODUCTS_REPO apontando para o checkout local de tetra-products");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("defina DATABASE_URL (a mesma do .env do tetra-products local)");
  process.exit(1);
}

const { PrismaClient } = await import(
  resolve(productsRepo, "src/infra/persistence/prisma/generated/client.ts")
);
const { PrismaPg } = await import(resolve(productsRepo, "node_modules/@prisma/adapter-pg"));

const csvPath = process.argv[2];
const TENANT_ID = process.argv[3] ?? "tenant_local_tetra";
if (!csvPath) {
  console.error("uso: bun scripts/seed-local-catalog.ts <planilha.csv> [tenantId]");
  process.exit(1);
}

function parseCsv(input: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  const [header, ...data] = rows;
  if (!header) return [];
  return data.map((values) =>
    Object.fromEntries(header.map((h, idx) => [h.trim(), (values[idx] ?? "").trim()])),
  );
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const text = await Bun.file(csvPath).text();
const records = parseCsv(text);

type LessonSeed = { title: string };
const courses = new Map<string, Map<string, LessonSeed[]>>();
for (const record of records) {
  const courseTitle = record.course_title;
  const moduleTitle = record.module_title ?? "";
  const lessonTitle = record.lesson_title;
  if (!courseTitle || !lessonTitle) continue;
  const modules = courses.get(courseTitle) ?? new Map<string, LessonSeed[]>();
  courses.set(courseTitle, modules);
  const lessons = modules.get(moduleTitle) ?? [];
  modules.set(moduleTitle, lessons);
  if (!lessons.some((lesson) => lesson.title === lessonTitle)) {
    lessons.push({ title: lessonTitle });
  }
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
let createdProducts = 0;
let createdLessons = 0;
let skipped = 0;

for (const [courseTitle, modules] of courses.entries()) {
  const existing = await prisma.product.findFirst({
    where: { tenantId: TENANT_ID, title: courseTitle, type: "COURSE", deletedAt: null },
  });
  if (existing) {
    skipped++;
    continue;
  }

  const product = await prisma.product.create({
    data: {
      tenantId: TENANT_ID,
      type: "COURSE",
      title: courseTitle,
      slug: `${slugify(courseTitle)}-${Math.random().toString(36).slice(2, 7)}`,
      status: "PUBLISHED",
      visibility: "PRIVATE",
    },
  });
  const course = await prisma.course.create({
    data: { productId: product.productId, tenantId: TENANT_ID },
  });

  let lessonOrder = 0;
  let moduleOrder = 0;
  for (const [moduleTitle, lessons] of modules.entries()) {
    let moduleId: string | null = null;
    if (moduleTitle) {
      const module = await prisma.courseModule.create({
        data: {
          courseId: course.courseId,
          tenantId: TENANT_ID,
          title: moduleTitle,
          order: moduleOrder++,
        },
      });
      moduleId = module.moduleId;
    }
    for (const lesson of lessons) {
      await prisma.lesson.create({
        data: {
          courseId: course.courseId,
          moduleId,
          tenantId: TENANT_ID,
          type: "VIDEO",
          title: lesson.title,
          order: lessonOrder++,
        },
      });
      createdLessons++;
    }
  }

  await prisma.course.update({
    where: { courseId: course.courseId },
    data: { totalLessons: lessonOrder },
  });
  createdProducts++;
  console.log(`criado: ${courseTitle} (${lessonOrder} aulas)`);
}

console.log(
  `seed concluido: ${createdProducts} cursos criados, ${createdLessons} aulas, ${skipped} ja existiam.`,
);
await prisma.$disconnect();
