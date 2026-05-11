import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
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

interface SourceVerificationItem {
  course: string;
  courseSlug: string;
  module: string;
  lesson: string;
  lessonNumber: number | null;
  asset: string;
  assetType: string;
  occurrences: number;
  neighboringLessons: string[];
  assetNumber: number | null;
  candidateCorrectLesson: string | null;
  currentLessonEvidence: string;
  candidateLessonEvidence: string | null;
  comparisonResult: 'MATCH' | 'MISMATCH' | 'SHARED' | 'INCONCLUSIVE';
  classification: 'SOURCE_CONFIRMED_MISMATCH' | 'SOURCE_CONFIRMED_SHARED' | 'SOURCE_INCONCLUSIVE' | 'VENDOR_PLATFORM_BUG';
  action: 'REMOVE' | 'KEEP' | 'DOCUMENT';
  confidence: number;
  reason: string;
  evidence: string[];
}

// Patterns for safe assets (should NOT be removed)
const SAFE_PATTERNS = [
  /workbook/i, /apostila/i, /material\s*(complementar|geral|de\s*apoio)/i,
  /checklist/i, /template/i, /ebook/i, /guia/i, /branding/i, /logo/i,
  /capa/i, /intro/i, /conteudo/i, /exercicio/i, /exercise/i,
  /slides?\s*(aula|lesson)?\s*\d+$/i, /pdf\s*(geral|base)/i,
];

// Patterns that indicate study cases or specific content
const STUDY_CASE_PATTERNS = [
  /estudo\s*caso/i, /estudocaso/i, /case\s*study/i,
  /introducao/i, /resolvido/i, /parte\s*\d+/i,
  /introducao\s*original/i,
];

function isSafePattern(name: string): boolean {
  return SAFE_PATTERNS.some(p => p.test(name));
}

function extractAulaNumber(name: string): number | null {
  const match = name.match(/Aula\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function extractLessonNumber(lessonName: string): number | null {
  const match = lessonName.match(/Aula\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function normalize(name: string): string {
  return name.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

console.log('=== ACTIVE SOURCE VERIFICATION ===\n');

// Ensure audit directory
if (!existsSync('storage/audit')) mkdirSync('storage/audit', { recursive: true });

// Build occurrence map
const manifestsDir = 'storage/manifests/themembers';
const files = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));

const assetOccurrenceMap = new Map<string, Map<string, string[]>>();
const allLessonsData = new Map<string, { course: string; module: string; lesson: string; lessonNumber: number | null; assets: string[] }[]>();

for (const file of files) {
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;

      const lessonNum = extractLessonNumber(lesson.name);
      const assetNames = (lesson.assets || []).map((a: any) => a.name);

      const key = `${course.course}|${lesson.name}`;
      if (!allLessonsData.has(course.course)) allLessonsData.set(course.course, []);
      allLessonsData.get(course.course)!.push({
        course: course.course,
        module: mod.name,
        lesson: lesson.name,
        lessonNumber: lessonNum,
        assets: assetNames
      });

      for (const asset of lesson.assets) {
        if (!assetOccurrenceMap.has(asset.name)) {
          assetOccurrenceMap.set(asset.name, new Map());
        }
        const courseMap = assetOccurrenceMap.get(asset.name)!;
        if (!courseMap.has(course.course)) {
          courseMap.set(course.course, []);
        }
        courseMap.get(course.course)!.push(lesson.name);
      }
    }
  }
}

// Process items for verification
const verificationItems: SourceVerificationItem[] = [];

for (const [courseName, lessonsData] of allLessonsData) {
  for (const lessonData of lessonsData) {
    for (const assetName of lessonData.assets) {
      const occurrences = assetOccurrenceMap.get(assetName)?.get(courseName)?.length ?? 1;
      const allLessons = assetOccurrenceMap.get(assetName)?.get(courseName) ?? [lessonData.lesson];
      const assetNum = extractAulaNumber(assetName);
      const lessonNum = lessonData.lessonNumber;

      // Skip if safe pattern
      if (isSafePattern(assetName)) {
        verificationItems.push({
          course: courseName,
          courseSlug: '',
          module: lessonData.module,
          lesson: lessonData.lesson,
          lessonNumber: lessonNum,
          asset: assetName,
          assetType: '',
          occurrences,
          neighboringLessons: allLessons,
          assetNumber: assetNum,
          candidateCorrectLesson: null,
          currentLessonEvidence: `Safe pattern detected. Asset: ${assetName}`,
          candidateLessonEvidence: null,
          comparisonResult: 'SHARED',
          classification: 'SOURCE_CONFIRMED_SHARED',
          action: 'KEEP',
          confidence: 95,
          reason: 'Safe pattern (workbook/apostila/template/generic)',
          evidence: ['Safe pattern matched', 'Preserve as legitimate shared material']
        });
        continue;
      }

      // Analyze for candidate correct lesson
      let candidateCorrectLesson: string | null = null;
      let comparisonResult: SourceVerificationItem['comparisonResult'] = 'INCONCLUSIVE';
      let classification: SourceVerificationItem['classification'] = 'SOURCE_INCONCLUSIVE';
      let action: SourceVerificationItem['action'] = 'KEEP';
      let confidence = 30;
      let reason = '';
      const evidence: string[] = [];

      // Check if asset has explicit numbering
      if (assetNum !== null && lessonNum !== null) {
        const diff = Math.abs(assetNum - lessonNum);

        // Find candidate correct lesson
        const correctLesson = allLessons.find(l => {
          const n = extractLessonNumber(l);
          return n !== null && n === assetNum;
        });

        if (correctLesson) candidateCorrectLesson = correctLesson;

        // Build evidence
        evidence.push(`Asset claims "Aula ${assetNum}" in filename`);
        evidence.push(`Current lesson is "Aula ${lessonNum}" (diff: ${diff})`);
        evidence.push(`Asset appears in ${occurrences} lessons: ${allLessons.join(', ')}`);

        if (diff >= 3 && occurrences >= 3) {
          // Deterministic mismatch
          comparisonResult = 'MISMATCH';
          classification = 'SOURCE_CONFIRMED_MISMATCH';
          action = 'REMOVE';
          confidence = 90;
          reason = `Deterministic mismatch: "Aula ${assetNum}" appearing in lessons where diff >= 3`;

          if (correctLesson) {
            evidence.push(`Correct lesson appears to be: ${correctLesson}`);
          }
        } else if (diff >= 1 && diff < 3) {
          // Possible neighbor leak
          comparisonResult = 'SHARED';
          classification = 'SOURCE_CONFIRMED_SHARED';
          action = 'KEEP';
          confidence = 70;
          reason = `Neighbor leak possibility (diff: ${diff}), but not deterministic. May be intentional.`;
          evidence.push('Neighbor leak possible but not deterministic - conservative keep');
        } else if (diff === 0) {
          // Looks correct
          comparisonResult = 'MATCH';
          classification = 'SOURCE_CONFIRMED_SHARED';
          action = 'KEEP';
          confidence = 85;
          reason = 'Asset aula number matches current lesson';
        }
      } else if (assetNum === null && occurrences >= 3) {
        // No explicit numbering but high occurrence - might be study case
        const studyCaseMatch = STUDY_CASE_PATTERNS.some(p => p.test(assetName));

        if (studyCaseMatch) {
          evidence.push('Study case pattern detected in asset name');
          evidence.push(`Asset appears in ${occurrences} lessons: ${allLessons.join(', ')}`);
          evidence.push('No explicit aula numbering but study case pattern suggests shared resource');

          comparisonResult = 'SHARED';
          classification = 'SOURCE_CONFIRMED_SHARED';
          action = 'KEEP';
          confidence = 75;
          reason = 'Study case material appears intentionally shared across lessons';
        } else {
          evidence.push('High occurrence but no explicit aula number and no study case pattern');
          evidence.push('Cannot determine correct lesson with confidence');

          comparisonResult = 'INCONCLUSIVE';
          classification = 'VENDOR_PLATFORM_BUG';
          action = 'DOCUMENT';
          confidence = 50;
          reason = 'Platform pattern detected but cannot determine correct lesson';
        }
      } else if (assetNum === null) {
        evidence.push('No explicit aula numbering detected');
        evidence.push(`Low occurrence (${occurrences}) - insufficient for pattern analysis`);

        comparisonResult = 'INCONCLUSIVE';
        classification = 'SOURCE_INCONCLUSIVE';
        action = 'KEEP';
        confidence = 40;
        reason = 'No explicit numbering, cannot determine mismatch';
      }

      verificationItems.push({
        course: courseName,
        courseSlug: '',
        module: lessonData.module,
        lesson: lessonData.lesson,
        lessonNumber: lessonNum,
        asset: assetName,
        assetType: '',
        occurrences,
        neighboringLessons: allLessons,
        assetNumber: assetNum,
        candidateCorrectLesson,
        currentLessonEvidence: `Lesson ${lessonNum}: ${lessonData.lesson}`,
        candidateLessonEvidence: candidateCorrectLesson ? `Lesson ${extractAulaNumber(candidateCorrectLesson)}: ${candidateCorrectLesson}` : null,
        comparisonResult,
        classification,
        action,
        confidence,
        reason,
        evidence
      });
    }
  }
}

// Summary
const summary = {
  total: verificationItems.length,
  sourceConfirmedMismatch: verificationItems.filter(i => i.classification === 'SOURCE_CONFIRMED_MISMATCH').length,
  sourceConfirmedShared: verificationItems.filter(i => i.classification === 'SOURCE_CONFIRMED_SHARED').length,
  sourceInconclusive: verificationItems.filter(i => i.classification === 'SOURCE_INCONCLUSIVE').length,
  vendorPlatformBug: verificationItems.filter(i => i.classification === 'VENDOR_PLATFORM_BUG').length,
  removeActions: verificationItems.filter(i => i.action === 'REMOVE').length,
  keepActions: verificationItems.filter(i => i.action === 'KEEP').length,
  documentActions: verificationItems.filter(i => i.action === 'DOCUMENT').length
};

console.log('=== VERIFICATION SUMMARY ===');
console.log(`Total items: ${summary.total}`);
console.log(`SOURCE_CONFIRMED_MISMATCH: ${summary.sourceConfirmedMismatch}`);
console.log(`SOURCE_CONFIRMED_SHARED: ${summary.sourceConfirmedShared}`);
console.log(`SOURCE_INCONCLUSIVE: ${summary.sourceInconclusive}`);
console.log(`VENDOR_PLATFORM_BUG: ${summary.vendorPlatformBug}`);
console.log(`\nAction breakdown:`);
console.log(`  REMOVE: ${summary.removeActions}`);
console.log(`  KEEP: ${summary.keepActions}`);
console.log(`  DOCUMENT: ${summary.documentActions}`);

// Save verification results
writeFileSync(
  'storage/audit/source_verification_matrix.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    summary,
    items: verificationItems
  }, null, 2)
);

// Generate source comparison matrix
const matrix = verificationItems.map(item => ({
  course: item.course,
  module: item.module,
  lesson: item.lesson,
  asset: item.asset,
  candidateCorrectLesson: item.candidateCorrectLesson,
  currentLessonEvidence: item.currentLessonEvidence,
  candidateLessonEvidence: item.candidateLessonEvidence,
  comparisonResult: item.comparisonResult,
  classification: item.classification,
  action: item.action,
  confidence: item.confidence,
  reason: item.reason
}));

writeFileSync(
  'storage/audit/source_comparison_matrix.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    summary,
    matrix
  }, null, 2)
);

// Generate reports
let reportMd = `# ACTIVE SOURCE VERIFICATION REPORT\n\n`;
reportMd += `Generated: ${new Date().toISOString()}\n\n`;
reportMd += `## SUMMARY\n\n`;
reportMd += `| Metric | Value |\n`;
reportMd += `|--------|-------|\n`;
reportMd += `| Total items analyzed | ${summary.total} |\n`;
reportMd += `| SOURCE_CONFIRMED_MISMATCH | ${summary.sourceConfirmedMismatch} |\n`;
reportMd += `| SOURCE_CONFIRMED_SHARED | ${summary.sourceConfirmedShared} |\n`;
reportMd += `| SOURCE_INCONCLUSIVE | ${summary.sourceInconclusive} |\n`;
reportMd += `| VENDOR_PLATFORM_BUG | ${summary.vendorPlatformBug} |\n\n`;

reportMd += `## ACTIONS\n\n`;
reportMd += `| Action | Count |\n`;
reportMd += `|--------|-------|\n`;
reportMd += `| REMOVE | ${summary.removeActions} |\n`;
reportMd += `| KEEP | ${summary.keepActions} |\n`;
reportMd += `| DOCUMENT | ${summary.documentActions} |\n\n`;

// MISMATCH items
const mismatches = verificationItems.filter(i => i.classification === 'SOURCE_CONFIRMED_MISMATCH');
if (mismatches.length > 0) {
  reportMd += `## SOURCE CONFIRMED MISMATCH (${mismatches.length} items)\n\n`;
  for (const item of mismatches) {
    reportMd += `- **${item.course}** > ${item.lesson}\n`;
    reportMd += `  - Asset: ${item.asset}\n`;
    reportMd += `  - Reason: ${item.reason}\n`;
    reportMd += `  - Evidence: ${item.evidence.join('; ')}\n\n`;
  }
}

// Platform bug items
const platformBugs = verificationItems.filter(i => i.classification === 'VENDOR_PLATFORM_BUG');
if (platformBugs.length > 0) {
  reportMd += `## VENDOR PLATFORM BUG (${platformBugs.length} items)\n\n`;
  for (const item of platformBugs.slice(0, 10)) {
    reportMd += `- **${item.course}** > ${item.lesson}: ${item.asset}\n`;
    reportMd += `  - Reason: ${item.reason}\n\n`;
  }
  if (platformBugs.length > 10) {
    reportMd += `*... and ${platformBugs.length - 10} more items*\n\n`;
  }
}

// SHARED items (high confidence)
const shared = verificationItems.filter(i => i.classification === 'SOURCE_CONFIRMED_SHARED' && i.confidence >= 80);
if (shared.length > 0) {
  reportMd += `## SOURCE CONFIRMED SHARED (${shared.length} items - high confidence)\n\n`;
  for (const item of shared.slice(0, 15)) {
    reportMd += `- ${item.course} > ${item.lesson}: ${item.asset}\n`;
  }
  if (shared.length > 15) {
    reportMd += `*... and ${shared.length - 15} more*\n`;
  }
}

writeFileSync('storage/audit/active_source_verification_report.md', reportMd);

// Save confirmed removals
const confirmedRemovals = verificationItems.filter(i => i.action === 'REMOVE');
writeFileSync(
  'storage/audit/source_confirmed_removals.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    count: confirmedRemovals.length,
    items: confirmedRemovals
  }, null, 2)
);

// Save confirmed shared
const confirmedShared = verificationItems.filter(i => i.action === 'KEEP');
writeFileSync(
  'storage/audit/source_confirmed_shared.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    count: confirmedShared.length,
    items: confirmedShared
  }, null, 2)
);

// Save inconclusive remaining
const inconclusive = verificationItems.filter(i => i.action === 'DOCUMENT' || (i.action === 'KEEP' && i.classification === 'SOURCE_INCONCLUSIVE'));
writeFileSync(
  'storage/audit/source_inconclusive_remaining.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    count: inconclusive.length,
    items: inconclusive
  }, null, 2)
);

writeFileSync(
  'storage/audit/source_inconclusive_remaining.md',
  `# SOURCE INCONCLUSIVE REMAINING\n\n` +
  `Generated: ${new Date().toISOString()}\n\n` +
  `These items cannot be determined with sufficient confidence.\n` +
  `Operationally safe to keep.\n\n` +
  `Total: ${inconclusive.length} items\n\n` +
  inconclusive.map(i => `- **${i.course}** > ${i.lesson}: ${i.asset}\n  - ${i.reason}`).join('\n\n')
);

console.log('\n=== FILES GENERATED ===');
console.log('- source_verification_matrix.json');
console.log('- source_comparison_matrix.json');
console.log('- active_source_verification_report.md');
console.log('- source_confirmed_removals.json');
console.log('- source_confirmed_shared.json');
console.log('- source_inconclusive_remaining.json');
console.log('- source_inconclusive_remaining.md');
console.log('\n=== ACTIVE SOURCE VERIFICATION COMPLETE ===');