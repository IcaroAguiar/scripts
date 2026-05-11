import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';

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
  offset: number;
  extensions: string;
}

interface RepeatedAsset {
  assetName: string;
  normalizedName: string;
  occurrences: number;
  courses: string[];
  lessons: Array<{course: string; lesson: string; offset: number}>;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reason: string;
}

interface LessonEntry {
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
}

interface Classification {
  assetName: string;
  course: string;
  lessonName: string;
  classification: 'DUPLICATE' | 'NEIGHBOR_LEAK' | 'LEGITIMATE' | 'AMBIGUOUS';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reason: string;
  evidence: string;
  action: 'REMOVE' | 'KEEP' | 'REVIEW';
}

interface ClassificationResult {
  generated: string;
  totalClassified: number;
  classifications: Classification[];
  summary: {
    duplicates: number;
    neighborLeaks: number;
    legitimate: number;
    ambiguous: number;
  };
  byCourse: Array<{
    course: string;
    courseSlug: string;
    classifications: Classification[];
    recommendedRemovals: number;
  }>;
}

// Ensure audit directory exists
if (!existsSync('storage/audit')) {
  mkdirSync('storage/audit', { recursive: true });
}

// Load data
const repeatedRaw = readFileSync('storage/audit/repeated_assets.json', 'utf8');
const repeatedAssets: RepeatedAsset[] = JSON.parse(repeatedRaw);

const inventoryRaw = readFileSync('storage/audit/inventory.json', 'utf8');
const inventory = JSON.parse(inventoryRaw);
const entries: AssetEntry[] = inventory.entries;

const lessonMapRaw = readFileSync('storage/audit/lesson_asset_map.json', 'utf8');
const lessonMap: LessonEntry[] = JSON.parse(lessonMapRaw);

// Phase 2: Heuristic Classification
console.log('=== FASE 2: Heuristic Classification ===\n');

const classifications: Classification[] = [];

// Group entries by course
const entriesByCourse = new Map<string, AssetEntry[]>();
for (const entry of entries) {
  if (!entriesByCourse.has(entry.courseSlug)) {
    entriesByCourse.set(entry.courseSlug, []);
  }
  entriesByCourse.get(entry.courseSlug)!.push(entry);
}

for (const [courseSlug, courseEntries] of entriesByCourse) {
  for (const entry of courseEntries) {
    if (entry.occurrencesGlobal < 2) {
      // Asset appears only once globally - legitimate
      classifications.push({
        assetName: entry.assetName,
        course: entry.course,
        lessonName: entry.lessonName,
        classification: 'LEGITIMATE',
        confidence: 'HIGH',
        reason: 'Asset appears only once globally',
        evidence: `Unique asset in ${entry.course}`,
        action: 'KEEP'
      });
      continue;
    }

    // Asset is repeated
    const repeatedInfo = repeatedAssets.find(
      r => r.normalizedName === entry.assetName.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s._-]/g, '').replace(/\s+/g, ' ').trim()
    );

    if (!repeatedInfo) {
      // Repeated but not in our repeated assets list
      classifications.push({
        assetName: entry.assetName,
        course: entry.course,
        lessonName: entry.lessonName,
        classification: 'AMBIGUOUS',
        confidence: 'LOW',
        reason: 'Repeated but not classified',
        evidence: `occurrencesGlobal: ${entry.occurrencesGlobal}`,
        action: 'REVIEW'
      });
      continue;
    }

    // === HIGH CONFIDENCE DUPLICATE ===
    // 1. Same asset in >5 lessons (likely global leak)
    if (repeatedInfo.occurrences > 5) {
      // Check if asset has specific "Aula XX" that doesn't match
      const aulaMatch = entry.assetName.match(/Aula\s*(\d+)/i);
      if (aulaMatch) {
        const aulaNum = parseInt(aulaMatch[1]);
        const lessonNums = repeatedInfo.lessons.map(l => {
          const m = l.lesson.match(/Aula\s*(\d+)/i);
          return m ? parseInt(m[1]) : -1;
        }).filter(n => n > 0);

        const allFarAway = lessonNums.length > 0 && lessonNums.every(ln => Math.abs(aulaNum - ln) > 2);

        if (allFarAway) {
          classifications.push({
            assetName: entry.assetName,
            course: entry.course,
            lessonName: entry.lessonName,
            classification: 'DUPLICATE',
            confidence: 'HIGH',
            reason: `GLOBAL LEAK: "Aula ${aulaNum}" appears in ${repeatedInfo.occurrences} lessons but lesson numbers are ${lessonNums.join(', ')}`,
            evidence: `Asset "${entry.assetName}" served to wrong lessons`,
            action: 'REMOVE'
          });
          continue;
        }
      }

      // Asset repeated >5 times without clear reason
      if (repeatedInfo.occurrences > 5) {
        classifications.push({
          assetName: entry.assetName,
          course: entry.course,
          lessonName: entry.lessonName,
          classification: 'DUPLICATE',
          confidence: 'HIGH',
          reason: `GLOBAL LEAK: Asset repeated ${repeatedInfo.occurrences}x across lessons`,
          evidence: `Lessons: ${repeatedInfo.lessons.map(l => l.lesson).join(', ')}`,
          action: 'REMOVE'
        });
        continue;
      }
    }

    // 2. Consistent offset (same asset appearing with same offset = bug)
    const offsets = repeatedInfo.lessons.map(l => l.offset).filter(o => o !== 0);
    if (offsets.length > 1) {
      const uniqueOffsets = new Set(offsets);
      if (uniqueOffsets.size === 1) {
        const aulaMatch = entry.assetName.match(/Aula\s*(\d+)/i);
        const aulaNum = aulaMatch ? parseInt(aulaMatch[1]) : null;

        classifications.push({
          assetName: entry.assetName,
          course: entry.course,
          lessonName: entry.lessonName,
          classification: 'DUPLICATE',
          confidence: 'HIGH',
          reason: `CONSISTENT OFFSET: All instances have offset ${[...uniqueOffsets][0]} (likely served from wrong source)`,
          evidence: `Asset claims "Aula ${aulaNum}" but has consistent offset ${[...uniqueOffsets][0]} in ${repeatedInfo.occurrences} lessons`,
          action: 'REMOVE'
        });
        continue;
      }
    }

    // === MEDIUM CONFIDENCE - NEIGHBOR LEAK ===
    // Asset appears in adjacent lessons (±1 or ±2)
    if (repeatedInfo.occurrences >= 2 && repeatedInfo.occurrences <= 5) {
      const offsets2 = repeatedInfo.lessons.map(l => l.offset);
      const hasNeighborOffset = offsets2.some(o => Math.abs(o) >= 1 && Math.abs(o) <= 2);

      if (hasNeighborOffset) {
        const aulaMatch = entry.assetName.match(/Aula\s*(\d+)/i);
        if (aulaMatch) {
          classifications.push({
            assetName: entry.assetName,
            course: entry.course,
            lessonName: entry.lessonName,
            classification: 'NEIGHBOR_LEAK',
            confidence: 'MEDIUM',
            reason: `NEIGHBOR LEAK: Asset from "Aula ${aulaMatch[1]}" leaking to adjacent lessons`,
            evidence: `Offset in this lesson: ${entry.offset}`,
            action: 'REVIEW'
          });
          continue;
        }
      }
    }

    // === LOW CONFIDENCE - POSSIBLE LEGITIMATE ===
    // Could be intentional shared material (workbook, template, etc.)
    const sharedKeywords = ['workbook', 'template', 'apostila', 'material complementar', 'guia', 'branding', 'logo', 'intro', 'capa'];
    const isPossiblyShared = sharedKeywords.some(k =>
      entry.assetName.toLowerCase().includes(k)
    );

    if (isPossiblyShared && repeatedInfo.occurrences <= 3) {
      classifications.push({
        assetName: entry.assetName,
        course: entry.course,
        lessonName: entry.lessonName,
        classification: 'LEGITIMATE',
        confidence: 'LOW',
        reason: 'POSSIBLE INTENTIONAL: Shared keyword found, low repetition',
        evidence: `Keyword match in asset name, ${repeatedInfo.occurrences} occurrences`,
        action: 'KEEP'
      });
      continue;
    }

    // Default to ambiguous
    classifications.push({
      assetName: entry.assetName,
      course: entry.course,
      lessonName: entry.lessonName,
      classification: 'AMBIGUOUS',
      confidence: 'MEDIUM',
      reason: 'Default ambiguous classification',
      evidence: `occurrences: ${repeatedInfo.occurrences}`,
      action: 'REVIEW'
    });
  }
}

// Group by course
const byCourseMap = new Map<string, Classification[]>();
for (const c of classifications) {
  if (!byCourseMap.has(c.course)) {
    byCourseMap.set(c.course, []);
  }
  byCourseMap.get(c.course)!.push(c);
}

const byCourse: ClassificationResult['byCourse'] = [];
for (const [course, cs] of byCourseMap) {
  const courseSlug = cs[0].course; // simplified
  byCourse.push({
    course,
    courseSlug,
    classifications: cs,
    recommendedRemovals: cs.filter(c => c.action === 'REMOVE').length
  });
}

// Summary
const summary = {
  duplicates: classifications.filter(c => c.classification === 'DUPLICATE').length,
  neighborLeaks: classifications.filter(c => c.classification === 'NEIGHBOR_LEAK').length,
  legitimate: classifications.filter(c => c.classification === 'LEGITIMATE').length,
  ambiguous: classifications.filter(c => c.classification === 'AMBIGUOUS').length,
};

const result: ClassificationResult = {
  generated: new Date().toISOString(),
  totalClassified: classifications.length,
  classifications,
  summary,
  byCourse
};

writeFileSync(
  'storage/audit/phase2-classification.json',
  JSON.stringify(result, null, 2)
);

console.log(`Total classified: ${classifications.length}`);
console.log(`\nSummary:`);
console.log(`  DUPLICATE (remove): ${summary.duplicates}`);
console.log(`  NEIGHBOR_LEAK (review): ${summary.neighborLeaks}`);
console.log(`  LEGITIMATE (keep): ${summary.legitimate}`);
console.log(`  AMBIGUOUS (review): ${summary.ambiguous}`);
console.log(`\nSaved to storage/audit/phase2-classification.json`);

// Generate suspicious assets report for manual review
const suspicious = classifications.filter(c => c.action === 'REVIEW');
const suspiciousReport = suspicious.map(c => ({
  ...c,
  affectedCourse: c.course,
  affectedLesson: c.lessonName
}));

writeFileSync(
  'storage/audit/suspicious_assets.json',
  JSON.stringify(suspiciousReport, null, 2)
);

console.log(`\nSuspicious assets for review: ${suspicious.length}`);
console.log('Saved to storage/audit/suspicious_assets.json');

console.log('\n=== FASE 2 COMPLETE ===');
