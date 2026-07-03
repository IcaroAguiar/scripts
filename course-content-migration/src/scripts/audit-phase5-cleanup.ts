import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, cpSync } from 'fs';

interface ConsensusDecision {
  assetName: string;
  course: string;
  lessons: string[];
  votes: string[];
  consensusReached: boolean;
  confidence: string;
  decision: string;
  reason: string;
}

interface RemovalAction {
  courseSlug: string;
  courseName: string;
  lessonName: string;
  assetName: string;
  reason: string;
  confidence: string;
}

// Ensure audit directory exists
if (!existsSync('storage/audit')) {
  mkdirSync('storage/audit', { recursive: true });
}

// Load consensus decisions
const consensus = JSON.parse(readFileSync('storage/audit/phase4-consensus.json', 'utf8'));
const decisions: ConsensusDecision[] = consensus.decisions;

console.log('=== FASE 5: EXECUTION ===\n');

// Get removal decisions
const removalDecisions = decisions.filter(d => d.decision === 'REMOVE');
const keepDecisions = decisions.filter(d => d.decision === 'KEEP');
const reviewDecisions = decisions.filter(d => d.decision === 'REVIEW');

console.log(`Removals approved: ${removalDecisions.length}`);
console.log(`Keep approved: ${keepDecisions.length}`);
console.log(`Review required: ${reviewDecisions.length}\n`);

// Backup manifests
console.log('Creating rollback backup...');
const rollbackDir = 'storage/audit/rollback_backup';
if (!existsSync(rollbackDir)) {
  mkdirSync(rollbackDir, { recursive: true });
}

const manifestsDir = 'storage/manifests/themembers';
const manifestFiles = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));

for (const file of manifestFiles) {
  cpSync(`${manifestsDir}/${file}`, `${rollbackDir}/${file}`);
}
console.log(`Backed up ${manifestFiles.length} manifests to ${rollbackDir}\n`);

// Count backed up
const rollbackFileCount = readdirSync(rollbackDir).filter(f => f.endsWith('.json')).length;
console.log(`Backed up ${rollbackFileCount} manifests`);

// Build removal actions
const removalActions: RemovalAction[] = [];
for (const decision of removalDecisions) {
  for (const lesson of decision.lessons) {
    removalActions.push({
      courseSlug: '', // Will fill in during processing
      courseName: decision.course,
      lessonName: lesson,
      assetName: decision.assetName,
      reason: decision.reason,
      confidence: decision.confidence
    });
  }
}

// Process each manifest
const MANIFESTS_DIR = 'storage/manifests/themembers';
const files = readdirSync(MANIFESTS_DIR).filter(f => f.endsWith('.json'));

let totalRemoved = 0;
const processedCourses = new Set<string>();
const removalReport: RemovalAction[] = [];

for (const file of files) {
  const courseSlug = file.replace('.json', '');
  const raw = readFileSync(`${MANIFESTS_DIR}/${file}`, 'utf8');
  const course = JSON.parse(raw);

  let courseModified = false;
  let courseRemovedCount = 0;

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;

      const originalAssetCount = lesson.assets.length;

      // Find assets to remove based on consensus decisions
      const normalizedAssetName = lesson.assets
        .map((a: any) => a.name.toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9\s._-]/g, '')
          .replace(/\s+/g, ' ')
          .trim());

      const assetsToRemove = new Set<number>();

      for (let i = 0; i < lesson.assets.length; i++) {
        const asset = lesson.assets[i];

        for (const decision of removalDecisions) {
          if (decision.course !== course.course) continue;

          // Normalize decision asset name for comparison
          const decisionNorm = decision.assetName
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s._-]/g, '')
            .replace(/\s+/g, ' ')
            .trim();

          // Check if this asset matches
          if (normalizedAssetName[i] === decisionNorm) {
            assetsToRemove.add(i);
            removalReport.push({
              courseSlug,
              courseName: course.course,
              lessonName: lesson.name,
              assetName: asset.name,
              reason: decision.reason,
              confidence: decision.confidence
            });
          }
        }
      }

      // Remove assets (in reverse order to maintain indices)
      const indicesToRemove = [...assetsToRemove].sort((a, b) => b - a);
      for (const idx of indicesToRemove) {
        lesson.assets.splice(idx, 1);
      }

      if (lesson.assets.length < originalAssetCount) {
        courseModified = true;
        courseRemovedCount += originalAssetCount - lesson.assets.length;
      }
    }
  }

  if (courseModified) {
    totalRemoved += courseRemovedCount;
    processedCourses.add(course.course);
    writeFileSync(`${MANIFESTS_DIR}/${file}`, JSON.stringify(course, null, 2));
    console.log(`CLEANED: ${course.course} (removed ${courseRemovedCount} assets)`);
  }
}

console.log(`\n=== CLEANUP COMPLETE ===`);
console.log(`Total assets removed: ${totalRemoved}`);
console.log(`Courses modified: ${processedCourses.size}`);

// Save cleaned manifests
const cleanedCourses = [...processedCourses];
writeFileSync(
  'storage/audit/cleaned_courses.json',
  JSON.stringify(cleanedCourses, null, 2)
);

// Generate removed_assets_report.md
let reportMd = `# REMOVED ASSETS REPORT\n\n`;
reportMd += `Generated: ${new Date().toISOString()}\n\n`;
reportMd += `## Summary\n`;
reportMd += `- Total assets removed: ${totalRemoved}\n`;
reportMd += `- Courses modified: ${processedCourses.size}\n`;
reportMd += `- Consensus decisions applied: ${removalDecisions.length} unique asset patterns\n\n`;
reportMd += `## Removed Assets\n\n`;

const byCourse = new Map<string, typeof removalReport>();
for (const r of removalReport) {
  if (!byCourse.has(r.courseName)) byCourse.set(r.courseName, []);
  byCourse.get(r.courseName)!.push(r);
}

for (const [courseName, removals] of byCourse) {
  reportMd += `### ${courseName}\n`;
  for (const r of removals) {
    reportMd += `- **${r.lessonName}**: ${r.assetName}\n`;
    reportMd += `  - Reason: ${r.reason}\n`;
    reportMd += `  - Confidence: ${r.confidence}\n\n`;
  }
}

writeFileSync('storage/audit/removed_assets_report.md', reportMd);

// Generate manual_review_queue.md
let reviewMd = `# MANUAL REVIEW QUEUE\n\n`;
reviewMd += `Generated: ${new Date().toISOString()}\n\n`;
reviewMd += `## Assets Requiring Human Review\n\n`;
reviewMd += `These assets were flagged but not removed due to lack of consensus or ambiguity.\n\n`;

const reviewByCourse = new Map<string, ConsensusDecision[]>();
for (const d of reviewDecisions) {
  if (!reviewByCourse.has(d.course)) reviewByCourse.set(d.course, []);
  reviewByCourse.get(d.course)!.push(d);
}

for (const [course, decisions] of reviewByCourse) {
  reviewMd += `### ${course}\n`;
  for (const d of decisions) {
    reviewMd += `- **${d.assetName}** (${d.lessons.length} lessons)\n`;
    reviewMd += `  - Reason: ${d.reason}\n`;
    reviewMd += `  - Confidence: ${d.confidence}\n\n`;
  }
}

writeFileSync('storage/audit/manual_review_queue.md', reviewMd);

// Generate platform_bug_report.md
let bugReportMd = `# PLATFORM BUG REPORT - TheMembers\n\n`;
bugReportMd += `Generated: ${new Date().toISOString()}\n\n`;
bugReportMd += `## Summary\n\n`;
bugReportMd += `This report documents systematic asset leaks identified in TheMembers platform export.\n\n`;
bugReportMd += `## Bug Patterns Identified\n\n`;

bugReportMd += `### 1. LINEAR OFFSET LEAKS\n`;
bugReportMd += `Assets from lesson N appearing consistently in lessons N-1, N-2, N-3...\n\n`;

for (const d of removalDecisions) {
  if (d.reason.includes('offset')) {
    bugReportMd += `- **${d.assetName}** (${d.course}): ${d.reason}\n`;
  }
}

bugReportMd += `\n### 2. GLOBAL DUPLICATION\n`;
bugReportMd += `Same asset attached to multiple lessons without proper scoping.\n\n`;

for (const d of removalDecisions) {
  if (d.reason.includes(' Systematic platform leak') || d.reason.includes('Duplicate')) {
    bugReportMd += `- **${d.assetName}** (${d.course}): ${d.lessons.length} occurrences\n`;
  }
}

bugReportMd += `\n### 3. MISMATCHED AULA NUMBER\n`;
bugReportMd += `Asset filename indicates "Aula X" but appears in lessons where XX != X.\n\n`;

for (const d of removalDecisions) {
  if (d.reason.includes('claims')) {
    bugReportMd += `- **${d.assetName}** (${d.course}): ${d.reason}\n`;
  }
}

bugReportMd += `\n## Affected Courses\n\n`;
for (const course of processedCourses) {
  const count = removalReport.filter(r => r.courseName === course).length;
  bugReportMd += `- ${course}: ${count} assets removed\n`;
}

writeFileSync('storage/audit/platform_bug_report.md', bugReportMd);

console.log('\n=== OUTPUTS GENERATED ===');
console.log('  - removed_assets_report.md');
console.log('  - manual_review_queue.md');
console.log('  - platform_bug_report.md');
console.log('  - rollback_backup/ (original manifests)');
console.log('  - cleaned_courses.json');
console.log('\n=== FASE 5 COMPLETE ===');