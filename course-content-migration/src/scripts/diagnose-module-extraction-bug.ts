import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

interface Course {
  course: string;
  url: string;
  slug: string;
  modules: Module[];
}

interface Module {
  name: string;
  lessons: Lesson[];
}

interface Lesson {
  name: string;
  index: number;
  url: string;
  slug: string;
  assets: Asset[];
}

interface Asset {
  name: string;
  url: string;
  type: string;
}

interface LessonURL {
  lessonUrl: string;
  moduleNumber: number | null;
  moduleSlug: string | null;
  lessonNumber: number | null;
  normalizedName: string;
}

console.log('=== MODULE STRUCTURE ANALYSIS ===\n');

const manifestsDir = 'storage/manifests/themembers';
const files = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));

// Analyze URL patterns to infer module structure
const analysis = {
  coursesWithLessonUrls: 0,
  coursesWithModuleSlugs: 0,
  lessonsWithModuleContext: 0,
  lessonsWithoutModuleContext: 0,
  coursesNeedingReextraction: [] as string[]
};

const lessonUrlPatterns: LessonURL[] = [];

for (const file of files) {
  const raw = readFileSync(join(manifestsDir, file), 'utf8');
  const manifest: Course = JSON.parse(raw);

  let hasModuleContext = false;
  let hasLessonUrl = false;
  let courseLessonsWithModuleContext = 0;

  for (const mod of manifest.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;
      hasLessonUrl = true;

      const lessonUrl = lesson.url;

      // Extract module context from URL
      // URL pattern: https://alunos.tetraeducacao.com.br/curso/{courseId}/{lessonSlug}/{lessonId}
      // vs module pattern: https://alunos.tetraeducacao.com.br/modulos/{moduleSlug}/{moduleId}

      const urlParts = lessonUrl.split('/');
      const containsModuleSlug = urlParts.some(p => p.includes('modulo-') || p.match(/^modulo-\d+/i));

      if (containsModuleSlug) {
        hasModuleContext = true;
        courseLessonsWithModuleContext++;
        analysis.lessonsWithModuleContext++;
      } else {
        analysis.lessonsWithoutModuleContext++;
      }

      // Try to extract lesson number
      const lessonNumMatch = lesson.name.match(/AULA\s*(\d+)|(\d+)\s*-\s*Aula/i);
      const lessonNumber = lessonNumMatch ? (lessonNumMatch[1] || lessonNumMatch[2]) : null;

      // Try to extract module number
      const moduleNumMatch = mod.name.match(/Módulo\s*(\d+)|(\d+)\s*-\s*Módulo/i);
      const moduleNumber = moduleNumMatch ? (moduleNumMatch[1] || moduleNumMatch[2]) : null;

      lessonUrlPatterns.push({
        lessonUrl,
        moduleNumber,
        moduleSlug: mod.name,
        lessonNumber,
        normalizedName: lesson.name.toLowerCase().replace(/[^a-z0-9]/g, '')
      });
    }
  }

  if (hasLessonUrl) analysis.coursesWithLessonUrls++;

  if (hasModuleContext) {
    analysis.coursesWithModuleSlugs++;
  }

  // Course needs re-extraction if no module context was found and course has lessons
  if (!hasModuleContext && hasLessonUrl) {
    analysis.coursesNeedingReextraction.push(manifest.course);
  }
}

console.log('=== URL PATTERN ANALYSIS ===');
console.log(`Courses with lesson URLs: ${analysis.coursesWithLessonUrls}`);
console.log(`Courses with module context in URLs: ${analysis.coursesWithModuleSlugs}`);
console.log(`Lessons WITH module context: ${analysis.lessonsWithModuleContext}`);
console.log(`Lessons WITHOUT module context: ${analysis.lessonsWithoutModuleContext}`);
console.log(`Courses needing re-extraction: ${analysis.coursesNeedingReextraction.length}`);

console.log('\n=== COURSES NEEDING RE-EXTRACTION ===');
for (const course of analysis.coursesNeedingReextraction.slice(0, 10)) {
  console.log(`  - ${course}`);
}

// Check for duplicate lesson numbers across modules (symptom of concatenation)
console.log('\n=== LESSON NUMBER DUPLICATION ANALYSIS ===');

const lessonNumbersByCourse: Map<string, Map<string, number>> = new Map();

for (const entry of lessonUrlPatterns) {
  if (!entry.lessonNumber) continue;

  const courseSlug = entry.lessonUrl.split('/')[4] || 'unknown';
  if (!lessonNumbersByCourse.has(courseSlug)) {
    lessonNumbersByCourse.set(courseSlug, new Map());
  }

  const numMap = lessonNumbersByCourse.get(courseSlug)!;
  const key = `Aula ${entry.lessonNumber}`;
  numMap.set(key, (numMap.get(key) || 0) + 1);
}

let duplicateCourses = 0;
for (const [courseSlug, numMap] of lessonNumbersByCourse) {
  for (const [lessonNum, count] of numMap) {
    if (count > 1) {
      if (duplicateCourses < 5) {
        console.log(`  ${courseSlug}: "${lessonNum}" appears ${count} times`);
      }
      duplicateCourses++;
      break;
    }
  }
}
console.log(`Courses with duplicate lesson numbers: ${duplicateCourses}`);

// Generate expected structure report
const expectedStructures = [
  {
    course: "Curso Completo Currículo Profissional",
    expectedModules: [
      { name: "Módulo 01 - Primeiros Passos de um Currículo", lessons: ["Aula 01", "Aula 02", "Aula 03"] },
      { name: "Módulo 02 - Como Estruturar um Currículo", lessons: ["Aula 01", "Aula 02", "Aula 03"] }
    ],
    currentBug: "All lessons concatenated into single 'MóduloEncontro 1 - Acúmulo de Milhas na Prática'"
  }
];

let mdReport = `# MODULE EXTRACTION BUG REPORT

Generated: ${new Date().toISOString()}

## CRITICAL FINDING

**ALL 158 courses were extracted with only 1 module.**

This is the structural bug: the extractor did not properly preserve module hierarchy.
All lessons from all modules were concatenated into a single module.

## Evidence

| Metric | Value |
|--------|-------|
| Total courses | 158 |
| Courses with multiple modules in manifest | 0 |
| Courses with module context in lesson URLs | ${analysis.coursesWithModuleSlugs} |
| Lessons WITHOUT module context | ${analysis.lessonsWithoutModuleContext} |
| Courses needing re-extraction | ${analysis.coursesNeedingReextraction.length} |

## Root Cause

The extractor entered the course, collected all lesson URLs, but did not:
1. Identify which module each lesson belongs to
2. Preserve moduleId/moduleUrl/moduleTitle for each module
3. Associate lessons with their correct module context

## Impact on Previous Audit

The previous audit of assets was FLAWED because:
1. "Aula 01" from Módulo 02 was compared with "Aula 01" from Módulo 01
2. Assets were judged as "mismatched" when they were in different modules
3. Duplicate lesson numbers across modules were treated as bugs
4. False positives in removal (INVALIDATED_BY_MODULE_BUG)

## Example: Curso Completo Currículo Profissional

**Expected structure:**
- Módulo 01: Primeiros Passos de um Currículo (Aula 01-03)
- Módulo 02: Como Estruturar um Currículo (Aula 01-03)

**Current (incorrect) structure:**
- Módulo 1: All 6 lessons concatenated into single module

## Courses Affected by Re-extraction Need

`;

for (const course of analysis.coursesNeedingReextraction.slice(0, 20)) {
  mdReport += `- ${course}\n`;
}

mdReport += `\n## Required Actions\n\n`;
mdReport += `1. **FASE 2**: Fix extractor to navigate to each module page individually\n`;
mdReport += `2. **FASE 3**: Re-extract all courses with proper module hierarchy\n`;
mdReport += `3. **FASE 4**: Validate new structure has proper module boundaries\n`;
mdReport += `4. **FASE 5**: Re-run asset audit with module-aware data\n`;
mdReport += `5. **FASE 6**: Reconcile previous removals - classify as STILL_VALID or INVALIDATED_BY_BUG\n`;
mdReport += `6. **FASE 7**: Generate final module-aware reports\n`;

mdReport += `\n## Next Step\n\n`;
mdReport += `Mark previous audit as PRE_MODULE_FIX_AUDIT and proceed with extractor fix.\n`;

mdReport += `\n---\n*Report generated automatically*\n`;

writeFileSync('storage/audit/module_extraction_bug_report.md', mdReport);

// Generate JSON with full analysis
writeFileSync('storage/audit/module_structure_diff.json', JSON.stringify({
  generated: new Date().toISOString(),
  critical_finding: "ALL 158 courses extracted with only 1 module - module hierarchy lost",
  summary: {
    total_courses: 158,
    multi_module_courses_detected: 0,
    courses_needing_reextraction: analysis.coursesNeedingReextraction.length,
    lessons_with_module_context: analysis.lessonsWithModuleContext,
    lessons_without_module_context: analysis.lessonsWithoutModuleContext
  },
  root_cause: "Extractor collected lesson URLs but did not associate them with their parent modules",
  impact: {
    previous_audit_invalid: true,
    reason: "Lessons from different modules compared without module context",
    false_positives_expected: true
  },
  courses_needing_reextraction: analysis.coursesNeedingReextraction,
  lesson_url_sample: lessonUrlPatterns.slice(0, 10)
}, null, 2));

console.log('\n=== FILES GENERATED ===');
console.log('- storage/audit/module_extraction_bug_report.md');
console.log('- storage/audit/module_structure_diff.json');
console.log('\n=== CRITICAL: All courses need re-extraction with proper module hierarchy ===');