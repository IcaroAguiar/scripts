import { readFileSync, writeFileSync, readdirSync } from 'fs';
import path from 'path';
import crypto from 'crypto';

interface Asset {
  type: string;
  name: string;
  url: string;
  sha256: string | null;
  status: string;
  uploadStatus: string;
  lastError?: string;
  driveFileId?: string;
  driveWebUrl?: string;
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

interface AssetEntry {
  course: string;
  courseSlug: string;
  module: string;
  lessonName: string;
  lessonIndex: number;
  assetName: string;
  assetType: string;
  url: string;
  occurrencesGlobal: number;
  occurrencesInCourse: number;
  lessonsWithThisAsset: string[];
  lessonNumbers: number[];
  offset: number; // difference between asset lesson number and lesson index
  extensions: string;
  hash?: string;
}

interface Inventory {
  generated: string;
  totalCourses: number;
  totalLessons: number;
  totalAssets: number;
  uniqueAssets: number;
  entries: AssetEntry[];
  repeatedAssets: Map<string, number>;
  courseIndex: Map<string, Course>;
}

// Build inventory
const MANIFESTS_DIR = 'storage/manifests/themembers';

function extractLessonNumber(lessonName: string): number | null {
  const match = lessonName.match(/Aula\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function getFileExtension(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext || 'no-ext';
}

function getAssetType(name: string): string {
  const ext = getFileExtension(name);
  const typeMap: Record<string, string> = {
    '.pdf': 'document',
    '.zip': 'archive',
    '.docx': 'document',
    '.doc': 'document',
    '.xlsx': 'spreadsheet',
    '.xls': 'spreadsheet',
    '.pptx': 'presentation',
    '.ppt': 'presentation',
    '.mp3': 'audio',
    '.m4a': 'audio',
    '.mp4': 'video',
    '.mov': 'video',
    '.png': 'image',
    '.jpg': 'image',
    '.jpeg': 'image',
    '.gif': 'image',
    '.svg': 'image',
  };
  return typeMap[ext] || 'unknown';
}

function normalizeForHash(name: string): string {
  return name.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const inventory: Inventory = {
  generated: new Date().toISOString(),
  totalCourses: 0,
  totalLessons: 0,
  totalAssets: 0,
  uniqueAssets: 0,
  entries: [],
  repeatedAssets: new Map(),
  courseIndex: new Map()
};

// Phase 1: Build global index
console.log('=== FASE 1: Building Global Inventory ===\n');

const files = readdirSync(MANIFESTS_DIR).filter(f => f.endsWith('.json'));

for (const file of files) {
  const raw = readFileSync(`${MANIFESTS_DIR}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);
  const courseSlug = file.replace('.json', '');

  inventory.courseIndex.set(courseSlug, course);
  inventory.totalCourses++;

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;
      inventory.totalLessons++;

      const lessonNum = extractLessonNumber(lesson.name);

      for (const asset of lesson.assets) {
        inventory.totalAssets++;

        const entry: AssetEntry = {
          course: course.course,
          courseSlug,
          module: mod.name,
          lessonName: lesson.name,
          lessonIndex: lessonNum ?? -1,
          assetName: asset.name,
          assetType: getAssetType(asset.name),
          url: asset.url,
          occurrencesGlobal: 0,
          occurrencesInCourse: 0,
          lessonsWithThisAsset: [],
          lessonNumbers: [],
          offset: 0,
          extensions: getFileExtension(asset.name)
        };

        inventory.entries.push(entry);
      }
    }
  }
}

// Calculate occurrences and offsets
const assetKeyMap = new Map<string, AssetEntry[]>();

for (const entry of inventory.entries) {
  const key = normalizeForHash(entry.assetName);
  if (!assetKeyMap.has(key)) {
    assetKeyMap.set(key, []);
  }
  assetKeyMap.get(key)!.push(entry);
}

for (const [key, entries] of assetKeyMap) {
  const occurrencesGlobal = entries.length;
  const courseOccurrences = new Map<string, number>();
  const lessonsSet = new Set<string>();

  for (const entry of entries) {
    // Calculate occurrence in course
    if (!courseOccurrences.has(entry.courseSlug)) {
      courseOccurrences.set(entry.courseSlug, 0);
    }
    courseOccurrences.set(entry.courseSlug, courseOccurrences.get(entry.courseSlug)! + 1);

    // Track lessons
    lessonsSet.add(`${entry.courseSlug}|${entry.lessonName}`);

    // Extract lesson numbers from asset name
    const assetNums = [];
    const matches = entry.assetName.match(/Aula\s*(\d+)/gi) || [];
    for (const m of matches) {
      const num = parseInt(m.match(/\d+/)![0]);
      assetNums.push(num);
    }

    entry.lessonNumbers = assetNums;

    // Calculate offset if we have both lesson number and asset number
    if (entry.lessonIndex > 0 && assetNums.length > 0) {
      entry.offset = assetNums[0] - entry.lessonIndex;
    }
  }

  for (const entry of entries) {
    entry.occurrencesGlobal = occurrencesGlobal;
    entry.occurrencesInCourse = courseOccurrences.get(entry.courseSlug) || 0;
    entry.lessonsWithThisAsset = [...new Set(
      entries
        .filter(e => e.courseSlug === entry.courseSlug)
        .map(e => e.lessonName)
    )];
  }
}

// Sort entries by course and lesson
inventory.entries.sort((a, b) => {
  if (a.courseSlug !== b.courseSlug) return a.courseSlug.localeCompare(b.courseSlug);
  return a.lessonIndex - b.lessonIndex;
});

// Save inventory
writeFileSync(
  'storage/audit/inventory.json',
  JSON.stringify(inventory, null, 2)
);

console.log(`Courses: ${inventory.totalCourses}`);
console.log(`Lessons: ${inventory.totalLessons}`);
console.log(`Total Assets: ${inventory.totalAssets}`);
console.log(`Unique Assets: ${assetKeyMap.size}`);
console.log(`Inventory saved to storage/audit/inventory.json`);

// Generate repeated assets report
const repeatedAssets: Array<{
  assetName: string;
  normalizedName: string;
  occurrences: number;
  courses: string[];
  lessons: Array<{course: string; lesson: string; offset: number}>;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reason: string;
}> = [];

for (const [key, entries] of assetKeyMap) {
  if (entries.length < 2) continue;

  const byCourse = new Map<string, typeof entries>();
  for (const e of entries) {
    if (!byCourse.has(e.courseSlug)) byCourse.set(e.courseSlug, []);
    byCourse.get(e.courseSlug)!.push(e);
  }

  for (const [courseSlug, courseEntries] of byCourse) {
    if (courseEntries.length < 2) continue;

    const lessons = courseEntries.map(e => ({
      course: e.course,
      lesson: e.lessonName,
      offset: e.offset
    }));

    // Determine confidence and reason
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
    let reason = '';

    if (courseEntries.length > 5) {
      confidence = 'HIGH';
      reason = `Asset repeated in ${courseEntries.length} lessons (>5 threshold)`;
    } else if (courseEntries.length > 3) {
      // Check if offsets are consistent (same asset, likely bug)
      const offsets = courseEntries.map(e => e.offset).filter(o => o !== 0);
      if (offsets.length > 0 && new Set(offsets).size === 1) {
        confidence = 'HIGH';
        reason = `Same asset with consistent offset ${offsets[0]} repeated ${courseEntries.length}x`;
      } else {
        confidence = 'MEDIUM';
        reason = `Asset repeated ${courseEntries.length}x with varying offsets`;
      }
    } else {
      confidence = 'MEDIUM';
      reason = `Asset repeated ${courseEntries.length}x, requires manual check`;
    }

    // Check if asset has specific "Aula XX" that doesn't match lessons
    const hasSpecificAulaNumber = entries[0].assetName.match(/Aula\s*(\d+)/i);
    if (hasSpecificAulaNumber) {
      const aulaNum = parseInt(hasSpecificAulaNumber[1]);
      const lessonNums = courseEntries.map(e => e.lessonIndex);
      const allFarAway = lessonNums.every(ln => ln > 0 && Math.abs(aulaNum - ln) > 2);
      if (allFarAway) {
        confidence = 'HIGH';
        reason = `Asset claims "Aula ${aulaNum}" but appears in lessons ${lessonNums.join(', ')}`;
      }
    }

    repeatedAssets.push({
      assetName: entries[0].assetName,
      normalizedName: key,
      occurrences: courseEntries.length,
      courses: [...new Set(courseEntries.map(e => e.course))],
      lessons,
      confidence,
      reason
    });
  }
}

// Sort by confidence (HIGH first) then by occurrences
repeatedAssets.sort((a, b) => {
  if (a.confidence !== b.confidence) {
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return order[a.confidence] - order[b.confidence];
  }
  return b.occurrences - a.occurrences;
});

writeFileSync(
  'storage/audit/repeated_assets.json',
  JSON.stringify(repeatedAssets, null, 2)
);

// Generate lesson asset map
const lessonAssetMap: Array<{
  course: string;
  courseSlug: string;
  module: string;
  lessonName: string;
  lessonIndex: number;
  assets: Array<{
    name: string;
    type: string;
    extension: string;
    occurrencesGlobal: number;
    occurrencesInCourse: number;
    offset: number;
    hasSpecificAula: boolean;
  }>;
}> = [];

for (const entry of inventory.entries) {
  // Group by course/lesson
}

const entriesByLesson = new Map<string, typeof inventory.entries>();
for (const entry of inventory.entries) {
  const key = `${entry.courseSlug}|${entry.lessonName}`;
  if (!entriesByLesson.has(key)) entriesByLesson.set(key, []);
  entriesByLesson.get(key)!.push(entry);
}

for (const [key, entries] of entriesByLesson) {
  const first = entries[0];
  lessonAssetMap.push({
    course: first.course,
    courseSlug: first.courseSlug,
    module: first.module,
    lessonName: first.lessonName,
    lessonIndex: first.lessonIndex,
    assets: entries.map(e => ({
      name: e.assetName,
      type: e.assetType,
      extension: e.extensions,
      occurrencesGlobal: e.occurrencesGlobal,
      occurrencesInCourse: e.occurrencesInCourse,
      offset: e.offset,
      hasSpecificAula: !!e.assetName.match(/Aula\s*(\d+)/i)
    }))
  });
}

lessonAssetMap.sort((a, b) => {
  if (a.courseSlug !== b.courseSlug) return a.courseSlug.localeCompare(b.courseSlug);
  return a.lessonIndex - b.lessonIndex;
});

writeFileSync(
  'storage/audit/lesson_asset_map.json',
  JSON.stringify(lessonAssetMap, null, 2)
);

// Summary statistics
console.log('\n=== REPEATED ASSETS SUMMARY ===');
const highCount = repeatedAssets.filter(a => a.confidence === 'HIGH').length;
const mediumCount = repeatedAssets.filter(a => a.confidence === 'MEDIUM').length;
const lowCount = repeatedAssets.filter(a => a.confidence === 'LOW').length;
console.log(`HIGH confidence (probable bugs): ${highCount}`);
console.log(`MEDIUM confidence (needs review): ${mediumCount}`);
console.log(`LOW confidence (likely legitimate): ${lowCount}`);
console.log(`\nSaved to storage/audit/repeated_assets.json`);

console.log('\n=== FASE 1 COMPLETE ===');
console.log('Generated:');
console.log('  - inventory.json (full raw data)');
console.log('  - repeated_assets.json (assets appearing 2+ times)');
console.log('  - lesson_asset_map.json (per-lesson asset summary)');
