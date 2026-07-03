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

interface ReviewItem {
  course: string;
  courseSlug: string;
  module: string;
  lesson: string;
  lessonNumber: number | null;
  asset: string;
  assetType: string;
  occurrences: number;
  neighboringLessons: string[];
  semanticMismatchScore: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  probableReason: string;
  evidence: string[];
  recommendation: 'KEEP' | 'REVIEW' | 'REMOVE_SUGGESTED';
  group: 'LIKELY_SAFE' | 'NEEDS_VISUAL_CHECK' | 'HIGH_SUSPICION' | 'PLATFORM_PATTERN';
  safePatterns: boolean;
  hasExplicitNumbering: boolean;
  offsetPattern: number | null;
}

// Safe patterns
const SAFE_PATTERNS = [
  /workbook/i, /apostila/i, /material\s*(complementar|geral|de\s*apoio)/i,
  /checklist/i, /template/i, /ebook/i, /guia/i, /branding/i, /logo/i,
  /capa/i, /intro/i, /conteudo/i, /exercicio/i, /exercise/i,
  /slides?\s*(aula|lesson)?\s*\d+/i, /pdf\s*(geral|base)/i,
];

const NUMBERING_PATTERNS = [
  /Aula\s*(\d+)/i, /Modulo\s*(\d+)/i, /módulo\s*(\d+)/i,
  /lesson\s*\d+/i, /classe\s*\d+/i,
];

function isSafePattern(name: string): boolean {
  return SAFE_PATTERNS.some(p => p.test(name));
}

function hasExplicitNumbering(name: string): boolean {
  return NUMBERING_PATTERNS.some(p => p.test(name));
}

function extractAulaNumber(name: string): number | null {
  const match = name.match(/Aula\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function extractLessonNumber(lessonName: string): number | null {
  const match = lessonName.match(/Aula\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function calculateMismatchScore(assetName: string, lessonName: string, occurrences: number): number {
  const assetAula = extractAulaNumber(assetName);
  const lessonAula = extractLessonNumber(lessonName);

  let score = 0;

  if (assetAula !== null && lessonAula !== null) {
    const diff = Math.abs(assetAula - lessonAula);
    if (diff >= 10) score += 50;
    else if (diff >= 5) score += 30;
    else if (diff >= 3) score += 15;
    else if (diff >= 1) score += 5;
  }

  // Occurrence pattern
  if (occurrences > 10) score += 20;
  else if (occurrences > 5) score += 10;
  else if (occurrences > 2) score += 5;

  // Check for consistent offset pattern
  // (would need global analysis, here we flag as pattern if occurs in sequence)
  if (occurrences >= 3) score += 15;

  return Math.min(score, 100);
}

function classifyReviewItem(
  assetName: string,
  lessonName: string,
  occurrences: number,
  evidence: string[],
  courseName: string
): ReviewItem['group'] {
  const safe = isSafePattern(assetName);
  const numbered = hasExplicitNumbering(assetName);
  const aulaNum = extractAulaNumber(assetName);
  const lessonNum = extractLessonNumber(lessonName);

  // LIKELY_SAFE: safe patterns without explicit problematic numbering
  if (safe && !numbered) return 'LIKELY_SAFE';
  if (safe && numbered && aulaNum !== null && lessonNum !== null && Math.abs(aulaNum - lessonNum) <= 2) {
    return 'LIKELY_SAFE';
  }

  // HIGH_SUSPICION: explicit mismatch >5 lessons or hash-like names
  if (aulaNum !== null && lessonNum !== null && Math.abs(aulaNum - lessonNum) >= 5) {
    return 'HIGH_SUSPICION';
  }

  // Platform pattern: high occurrences with no clear lesson match
  if (occurrences >= 5 && !safe && !numbered) return 'PLATFORM_PATTERN';
  if (occurrences >= 3 && numbered && aulaNum !== null && lessonNum !== null && Math.abs(aulaNum - lessonNum) >= 3) {
    return 'HIGH_SUSPICION';
  }

  // NEEDS_VISUAL_CHECK: everything else with explicit numbering but no clear mismatch
  if (numbered) return 'NEEDS_VISUAL_CHECK';

  // Platform pattern if appears in many lessons but not clearly safe
  if (occurrences >= 4 && !safe) return 'PLATFORM_PATTERN';

  return 'NEEDS_VISUAL_CHECK';
}

function determineRecommendation(
  group: ReviewItem['group'],
  mismatchScore: number,
  evidence: string[]
): ReviewItem['recommendation'] {
  if (group === 'LIKELY_SAFE') return 'KEEP';
  if (group === 'HIGH_SUSPICION' && mismatchScore >= 50) return 'REMOVE_SUGGESTED';
  if (group === 'PLATFORM_PATTERN') return 'REVIEW';
  return 'REVIEW';
}

console.log('=== HUMAN REVIEW ASSISTED ===\n');

// Load manifests
const manifestsDir = 'storage/manifests/themembers';
const files = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));

// Global asset occurrence tracking
const assetOccurrenceMap = new Map<string, Map<string, string[]>>(); // asset -> course -> lessons

// First pass: build occurrence map
for (const file of files) {
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;

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

// Second pass: build review items
const reviewItems: ReviewItem[] = [];

for (const file of files) {
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;

      const lessonNum = extractLessonNumber(lesson.name);

      for (const asset of lesson.assets) {
        const occurrences = assetOccurrenceMap.get(asset.name)?.get(course.course)?.length ?? 1;
        const neighboringLessons = assetOccurrenceMap.get(asset.name)?.get(course.course) ?? [];

        const mismatchScore = calculateMismatchScore(asset.name, lesson.name, occurrences);

        const evidence: string[] = [];
        const aulaNum = extractAulaNumber(asset.name);
        if (aulaNum !== null && lessonNum !== null) {
          const diff = Math.abs(aulaNum - lessonNum);
          evidence.push(`Aula ${aulaNum} in filename vs Aula ${lessonNum} in lesson (diff: ${diff})`);
        }
        if (occurrences > 1) {
          evidence.push(`Appears in ${occurrences} lessons in this course`);
        }

        let probableReason = '';
        if (aulaNum !== null && lessonNum !== null && Math.abs(aulaNum - lessonNum) > 2) {
          probableReason = `Asset claims "Aula ${aulaNum}" but lesson is "${lessonNum}"`;
        } else if (occurrences > 5) {
          probableReason = `High replication (${occurrences}x) suggests platform leak`;
        } else {
          probableReason = 'Ambiguous classification - needs human judgment';
        }

        const safe = isSafePattern(asset.name);
        const numbered = hasExplicitNumbering(asset.name);

        const group = classifyReviewItem(asset.name, lesson.name, occurrences, evidence, course.course);
        const recommendation = determineRecommendation(group, mismatchScore, evidence);

        reviewItems.push({
          course: course.course,
          courseSlug: course.slug,
          module: mod.name,
          lesson: lesson.name,
          lessonNumber: lessonNum,
          asset: asset.name,
          assetType: asset.type,
          occurrences,
          neighboringLessons,
          semanticMismatchScore: mismatchScore,
          confidence: mismatchScore >= 50 ? 'HIGH' : mismatchScore >= 30 ? 'MEDIUM' : 'LOW',
          probableReason,
          evidence,
          recommendation,
          group,
          safePatterns: safe,
          hasExplicitNumbering: numbered,
          offsetPattern: (aulaNum !== null && lessonNum !== null) ? aulaNum - lessonNum : null
        });
      }
    }
  }
}

// Group items
const groups = {
  LIKELY_SAFE: reviewItems.filter(i => i.group === 'LIKELY_SAFE'),
  NEEDS_VISUAL_CHECK: reviewItems.filter(i => i.group === 'NEEDS_VISUAL_CHECK'),
  HIGH_SUSPICION: reviewItems.filter(i => i.group === 'HIGH_SUSPICION'),
  PLATFORM_PATTERN: reviewItems.filter(i => i.group === 'PLATFORM_PATTERN'),
};

// Sort by priority (mismatch score descending)
groups.HIGH_SUSPICION.sort((a, b) => b.semanticMismatchScore - a.semanticMismatchScore);
groups.PLATFORM_PATTERN.sort((a, b) => b.occurrences - a.occurrences);
groups.NEEDS_VISUAL_CHECK.sort((a, b) => b.occurrences - a.occurrences);
groups.LIKELY_SAFE.sort((a, b) => a.asset.localeCompare(b.asset));

console.log('=== GROUP SUMMARY ===');
console.log(`HIGH_SUSPICION: ${groups.HIGH_SUSPICION.length}`);
console.log(`PLATFORM_PATTERN: ${groups.PLATFORM_PATTERN.length}`);
console.log(`NEEDS_VISUAL_CHECK: ${groups.NEEDS_VISUAL_CHECK.length}`);
console.log(`LIKELY_SAFE: ${groups.LIKELY_SAFE.length}`);
console.log(`Total: ${reviewItems.length}`);

// Save grouped review items
writeFileSync(
  'storage/audit/review_queue_grouped.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    summary: {
      highSuspicion: groups.HIGH_SUSPICION.length,
      platformPattern: groups.PLATFORM_PATTERN.length,
      needsVisualCheck: groups.NEEDS_VISUAL_CHECK.length,
      likelySafe: groups.LIKELY_SAFE.length
    },
    groups
  }, null, 2)
);

// Generate review dashboard markdown
let dashboardMd = `# HUMAN REVIEW DASHBOARD\n\n`;
dashboardMd += `Generated: ${new Date().toISOString()}\n\n`;
dashboardMd += `## PRIORITY QUEUE\n\n`;
dashboardMd += `### 🚨 HIGH_SUSPICION (${groups.HIGH_SUSPICION.length} items)\n\n`;
dashboardMd += `**Action Required**: Review immediately - strong evidence of wrong asset\n\n`;

for (const item of groups.HIGH_SUSPICION) {
  dashboardMd += `---\n`;
  dashboardMd += `**Course**: ${item.course}\n`;
  dashboardMd += `**Lesson**: ${item.lesson}\n`;
  dashboardMd += `**Module**: ${item.module}\n\n`;
  dashboardMd += `**Asset**: ${item.asset}\n`;
  dashboardMd += `**Type**: ${item.assetType}\n`;
  dashboardMd += `**Confidence**: ${item.confidence}\n`;
  dashboardMd += `**Mismatch Score**: ${item.semanticMismatchScore}/100\n\n`;
  dashboardMd += `**Occurrences**: ${item.occurrences}\n`;
  dashboardMd += `**Neighboring Lessons**: ${item.neighboringLessons.join(', ')}\n\n`;
  dashboardMd += `**Probable Reason**: ${item.probableReason}\n`;
  dashboardMd += `**Evidence**: ${item.evidence.join('; ')}\n\n`;
  dashboardMd += `**Recommendation**: ${item.recommendation}\n`;
  if (item.recommendation === 'REMOVE_SUGGESTED') {
    dashboardMd += `⚠️ AI suggests removal but awaiting human approval\n`;
  }
  dashboardMd += `\n`;
}

dashboardMd += `---\n\n`;
dashboardMd += `### 🔶 PLATFORM_PATTERN (${groups.PLATFORM_PATTERN.length} items)\n\n`;
dashboardMd += `**Action Required**: Document for TheMembers vendor report\n\n`;

for (const item of groups.PLATFORM_PATTERN) {
  dashboardMd += `---\n`;
  dashboardMd += `**Course**: ${item.course}\n`;
  dashboardMd += `**Lesson**: ${item.lesson}\n`;
  dashboardMd += `**Asset**: ${item.asset}\n`;
  dashboardMd += `**Occurrences**: ${item.occurrences}\n`;
  dashboardMd += `**Confidence**: ${item.confidence}\n`;
  dashboardMd += `**Reason**: ${item.probableReason}\n`;
  dashboardMd += `**Recommendation**: ${item.recommendation}\n\n`;
}

dashboardMd += `---\n\n`;
dashboardMd += `### 👀 NEEDS_VISUAL_CHECK (${groups.NEEDS_VISUAL_CHECK.length} items)\n\n`;
dashboardMd += `**Action Required**: Quick human verification\n\n`;

for (const item of groups.NEEDS_VISUAL_CHECK.slice(0, 30)) {
  dashboardMd += `---\n`;
  dashboardMd += `**${item.course}** > ${item.lesson}\n`;
  dashboardMd += `Asset: ${item.asset}\n`;
  dashboardMd += `Occurrences: ${item.occurrences} | Confidence: ${item.confidence}\n`;
  dashboardMd += `Reason: ${item.probableReason}\n`;
  dashboardMd += `Recommendation: ${item.recommendation}\n\n`;
}
if (groups.NEEDS_VISUAL_CHECK.length > 30) {
  dashboardMd += `*... and ${groups.NEEDS_VISUAL_CHECK.length - 30} more items*\n\n`;
}

dashboardMd += `---\n\n`;
dashboardMd += `### ✅ LIKELY_SAFE (${groups.LIKELY_SAFE.length} items)\n\n`;
dashboardMd += `**Action**: Auto-approved - legitimate shared materials\n\n`;

for (const item of groups.LIKELY_SAFE.slice(0, 20)) {
  dashboardMd += `- ${item.course} > ${item.lesson}: ${item.asset}\n`;
}
if (groups.LIKELY_SAFE.length > 20) {
  dashboardMd += `*... and ${groups.LIKELY_SAFE.length - 20} more (auto-approved)*\n`;
}

dashboardMd += `\n---\n\n`;
dashboardMd += `## SUMMARY STATS\n\n`;
dashboardMd += `| Group | Count | Priority |\n`;
dashboardMd += `|-------|-------|----------|\n`;
dashboardMd += `| HIGH_SUSPICION | ${groups.HIGH_SUSPICION.length} | 🚨 Critical |\n`;
dashboardMd += `| PLATFORM_PATTERN | ${groups.PLATFORM_PATTERN.length} | 🔶 Document |\n`;
dashboardMd += `| NEEDS_VISUAL_CHECK | ${groups.NEEDS_VISUAL_CHECK.length} | 👀 Verify |\n`;
dashboardMd += `| LIKELY_SAFE | ${groups.LIKELY_SAFE.length} | ✅ Auto-keep |\n\n`;

dashboardMd += `## AI CANNOT APPLY REMOVALS\n\n`;
dashboardMd += `This queue requires human review. AI has flagged items but final decision belongs to human reviewer.\n`;
dashboardMd += `Priority order: HIGH_SUSPICION → PLATFORM_PATTERN → NEEDS_VISUAL_CHECK → LIKELY_SAFE\n`;

writeFileSync('storage/audit/review_dashboard.md', dashboardMd);

// Generate asset preview metadata where possible
console.log('\n=== GENERATING ASSET PREVIEW METADATA ===');

interface AssetPreview {
  asset: string;
  course: string;
  lesson: string;
  type: string;
  extension: string;
  probableContent: string;
  riskLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  notes: string;
}

const previews: AssetPreview[] = [];

for (const item of reviewItems) {
  const ext = path.extname(item.asset).toLowerCase();
  let probableContent = 'Unknown';
  let notes = '';

  if (ext === '.pdf') {
    probableContent = 'Document/PDF';
    notes = 'Check if lesson content matches PDF title';
  } else if (ext === '.zip') {
    probableContent = 'Compressed archive (likely audio/video)';
    notes = 'Verify audio file matches lesson';
  } else if (ext === '.mp3' || ext === '.m4a') {
    probableContent = 'Audio file';
    notes = 'Duration and content should match lesson';
  } else if (ext === '.xlsx' || ext === '.xls') {
    probableContent = 'Spreadsheet/Excel';
    notes = 'Verify spreadsheet relates to lesson topic';
  } else if (ext === '.docx' || ext === '.doc') {
    probableContent = 'Word document';
    notes = 'Check if document matches lesson';
  } else if (ext === '.mp4' || ext === '.mov') {
    probableContent = 'Video file';
    notes = 'Duration and content should match lesson';
  }

  let riskLevel: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
  if (item.group === 'HIGH_SUSPICION') riskLevel = 'HIGH';
  else if (item.group === 'PLATFORM_PATTERN') riskLevel = 'MEDIUM';

  previews.push({
    asset: item.asset,
    course: item.course,
    lesson: item.lesson,
    type: item.assetType,
    extension: ext,
    probableContent,
    riskLevel,
    notes
  });
}

writeFileSync(
  'storage/audit/asset_preview_metadata.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    totalAssets: previews.length,
    byRiskLevel: {
      high: previews.filter(p => p.riskLevel === 'HIGH').length,
      medium: previews.filter(p => p.riskLevel === 'MEDIUM').length,
      low: previews.filter(p => p.riskLevel === 'LOW').length
    },
    assets: previews
  }, null, 2)
);

console.log(`Preview metadata generated for ${previews.length} assets`);
console.log('\nFiles generated:');
console.log('  - review_queue_grouped.json');
console.log('  - review_dashboard.md');
console.log('  - asset_preview_metadata.json');
console.log('\n=== HUMAN REVIEW ASSISTED COMPLETE ===');