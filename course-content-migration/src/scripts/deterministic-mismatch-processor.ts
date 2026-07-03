import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, cpSync } from 'fs';
import path from 'path';

interface Asset {
  type: string;
  name: string;
  url: string;
  sha256: string | null;
  status: string;
  uploadStatus: string;
}

interface Lesson {
  name: string;
  index: number;
  url: string;
  slug: string;
  description: string;
  links: string[];
  assets: Asset[];
  status: string;
}

interface Module {
  name: string;
  lessons: Lesson[];
}

interface Course {
  course: string;
  url: string;
  slug: string;
  modules: Module[];
}

interface DeterministicItem {
  course: string;
  courseSlug: string;
  module: string;
  lesson: string;
  lessonNumber: number | null;
  asset: string;
  assetNumber: number | null;
  assetModuleNumber: number | null;
  type: string;
  occurrences: number;
  mismatchedLessons: string[];
  diff: number;
  evidence: string;
  action: 'REMOVE_DETERMINISTIC' | 'KEEP_SAFE' | 'REVIEW';
  reason: string;
}

// Patterns that indicate safe/material that doesn't indicate specific lesson
const SAFE_PATTERNS = [
  /workbook/i, /apostila/i, /material\s*(complementar|geral|de\s*apoio)/i,
  /checklist/i, /template/i, /ebook/i, /guia/i, /branding/i, /logo/i,
  /capa/i, /intro/i, /conteudo/i, /exercicio/i, /exercise/i,
  /slides?\s*(aula|lesson)?\s*\d+$/i, // Generic slides like "Slides Aula 1"
];

// Patterns that indicate explicit lesson numbering
const NUMBERING_PATTERNS = [
  /Aula\s*(\d+)/i,
  /Lesson\s*(\d+)/i,
  /Modulo\s*(\d+)/i,
  /módulo\s*(\d+)/i,
  /AUDIOAULA\s*(\d+)/i,
  /audiobook\s*(aula|lesson)?\s*(\d+)/i,
];

function isSafePattern(name: string): boolean {
  return SAFE_PATTERNS.some(p => p.test(name));
}

function extractNumber(name: string, pattern: RegExp): number | null {
  const match = name.match(pattern);
  return match ? parseInt(match[1]) : null;
}

function extractAllNumbers(name: string): { aula: number | null; modulo: number | null; audiobook: number | null } {
  return {
    aula: extractNumber(name, /Aula\s*(\d+)/i),
    modulo: extractNumber(name, /(?:Modulo|módulo)\s*(\d+)/i),
    audiobook: extractNumber(name, /AUDIOAULA\s*(\d+)/i)
  };
}

function getLessonNumber(lessonName: string): number | null {
  const match = lessonName.match(/Aula\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

console.log('=== DETERMINISTIC MISMATCH PROCESSOR ===\n');

// Load all manifests and build global occurrence map
const manifestsDir = 'storage/manifests/themembers';
const files = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));

// Global map: assetName -> course -> [lessons]
const globalMap = new Map<string, Map<string, string[]>>();

for (const file of files) {
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;

      for (const asset of lesson.assets) {
        if (!globalMap.has(asset.name)) {
          globalMap.set(asset.name, new Map());
        }
        const courseMap = globalMap.get(asset.name)!;
        if (!courseMap.has(course.course)) {
          courseMap.set(course.course, []);
        }
        courseMap.get(course.course)!.push(lesson.name);
      }
    }
  }
}

// Process each course
const deterministicItems: DeterministicItem[] = [];
const safeItems: DeterministicItem[] = [];
const reviewItems: DeterministicItem[] = [];

for (const file of files) {
  const courseSlug = file.replace('.json', '');
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;

      const lessonNum = getLessonNumber(lesson.name);
      const courseLessons = globalMap.get(lesson.name) || new Map();

      for (const asset of lesson.assets) {
        const occurrences = globalMap.get(asset.name)?.get(course.course)?.length ?? 1;
        const allLessonsWithAsset = globalMap.get(asset.name)?.get(course.course) ?? [lesson.name];
        const numbers = extractAllNumbers(asset.name);
        const assetNumber = numbers.aula ?? numbers.audiobook ?? numbers.modulo;

        // Determine action
        const safe = isSafePattern(asset.name);
        const hasExplicitNumbering = assetNumber !== null;
        const diff = (lessonNum !== null && assetNumber !== null) ? Math.abs(assetNumber - lessonNum) : 0;

        let action: DeterministicItem['action'];
        let reason: string;

        // DETERMINISTIC MISMATCH criteria:
        // 1. Has explicit numbering in asset name
        // 2. Occurs in >= 3 lessons
        // 3. Mismatch diff >= 3
        if (hasExplicitNumbering && occurrences >= 3 && diff >= 3) {
          action = 'REMOVE_DETERMINISTIC';
          reason = `DETERMINISTIC: "Aula ${assetNumber}" appears in ${occurrences} lessons, diff=${diff} from current lesson`;
        } else if (safe || !hasExplicitNumbering) {
          action = 'KEEP_SAFE';
          reason = safe ? 'Safe pattern (workbook/apostila/template)' : 'No explicit numbering - preserve';
        } else {
          action = 'REVIEW';
          reason = hasExplicitNumbering
            ? `Numbering exists but occurrences (${occurrences}) < 3 or diff (${diff}) < 3`
            : 'Ambiguous - requires human judgment';
        }

        const item: DeterministicItem = {
          course: course.course,
          courseSlug,
          module: mod.name,
          lesson: lesson.name,
          lessonNumber: lessonNum,
          asset: asset.name,
          assetNumber,
          assetModuleNumber: numbers.modulo,
          type: asset.type,
          occurrences,
          mismatchedLessons: allLessonsWithAsset.filter(l => {
            const n = getLessonNumber(l);
            return n !== null && assetNumber !== null && Math.abs(n - assetNumber) >= 3;
          }),
          diff,
          evidence: hasExplicitNumbering
            ? `"${asset.name}" claims "Aula ${assetNumber}", lesson is ${lessonNum}, diff=${diff}, occurrences=${occurrences}`
            : `No explicit numbering in "${asset.name}"`,
          action,
          reason
        };

        if (action === 'REMOVE_DETERMINISTIC') deterministicItems.push(item);
        else if (action === 'KEEP_SAFE') safeItems.push(item);
        else reviewItems.push(item);
      }
    }
  }
}

// Summary
console.log(`Total assets processed: ${deterministicItems.length + safeItems.length + reviewItems.length}`);
console.log(`\nDeterministic (auto-remove): ${deterministicItems.length}`);
console.log(`Safe (auto-keep): ${safeItems.length}`);
console.log(`Review (human): ${reviewItems.length}\n`);

// Show deterministic items
console.log('=== DETERMINISTIC MISMATCH ITEMS (will auto-remove) ===\n');
for (const item of deterministicItems) {
  console.log(`REMOVE: ${item.asset} from ${item.course}`);
  console.log(`  Lesson: ${item.lesson} (${item.lessonNumber}) vs asset claims (${item.assetNumber})`);
  console.log(`  Reason: ${item.reason}`);
  console.log(`  Occurrences: ${item.occurrences}, diff: ${item.diff}`);
  console.log('');
}

// Save the analysis
writeFileSync(
  'storage/audit/deterministic_analysis.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    summary: {
      deterministic: deterministicItems.length,
      safe: safeItems.length,
      review: reviewItems.length
    },
    deterministicItems,
    safeItems,
    reviewItems
  }, null, 2)
);

console.log(`\nAnalysis saved to storage/audit/deterministic_analysis.json`);
console.log('\n=== PROCESSING COMPLETE ===');
console.log('Next step: Run deterministic cleanup to apply removals');