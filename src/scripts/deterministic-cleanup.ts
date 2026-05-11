import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, cpSync } from 'fs';

interface DeterministicItem {
  course: string;
  courseSlug: string;
  module: string;
  lesson: string;
  lessonNumber: number | null;
  asset: string;
  assetNumber: number | null;
  type: string;
  occurrences: number;
  diff: number;
  action: string;
  reason: string;
}

// Backup first
console.log('=== APPLYING DETERMINISTIC REMOVALS ===\n');

const rollbackDir = 'storage/audit/deterministic_backup';
if (!existsSync(rollbackDir)) mkdirSync(rollbackDir, { recursive: true });

const manifestsDir = 'storage/manifests/themembers';
const files = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));

// Backup all
for (const file of files) {
  cpSync(`${manifestsDir}/${file}`, `${rollbackDir}/${file}`);
}
console.log(`Backed up ${files.length} manifests to ${rollbackDir}\n`);

// Load deterministic items
const analysis = JSON.parse(readFileSync('storage/audit/deterministic_analysis.json', 'utf8'));
const deterministicItems: DeterministicItem[] = analysis.deterministicItems;

console.log(`Applying ${deterministicItems.length} deterministic removals...\n`);

// Normalize asset name for comparison
function normalize(name: string): string {
  return name.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build lookup map
const toRemove = new Map<string, Set<string>>(); // course -> asset names to remove
for (const item of deterministicItems) {
  if (!toRemove.has(item.course)) toRemove.set(item.course, new Set());
  toRemove.get(item.course)!.add(item.asset);
}

// Process manifests
let totalRemoved = 0;
const removalLog: Array<{course: string; lesson: string; asset: string; reason: string}> = [];

for (const file of files) {
  const courseSlug = file.replace('.json', '');
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
  const course = JSON.parse(raw);

  const assetsToRemove = toRemove.get(course.course);
  if (!assetsToRemove || assetsToRemove.size === 0) continue;

  let modified = false;

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;

      const originalCount = lesson.assets.length;
      const toRemoveNormalized = new Set([...assetsToRemove].map(normalize));

      lesson.assets = lesson.assets.filter((a: any) => {
        const assetNorm = normalize(a.name);
        if (toRemoveNormalized.has(assetNorm)) {
          removalLog.push({
            course: course.course,
            lesson: lesson.name,
            asset: a.name,
            reason: `DETERMINISTIC_MISMATCH: appears in ${deterministicItems.find(d => d.asset === a.name)?.occurrences} lessons`
          });
          return false;
        }
        return true;
      });

      if (lesson.assets.length < originalCount) modified = true;
      totalRemoved += originalCount - lesson.assets.length;
    }
  }

  if (modified) {
    writeFileSync(`${manifestsDir}/${file}`, JSON.stringify(course, null, 2));
    console.log(`CLEANED: ${course.course} (${[...assetsToRemove].join(', ')})`);
  }
}

console.log(`\n=== DETERMINISTIC REMOVAL COMPLETE ===`);
console.log(`Total assets removed: ${totalRemoved}`);
console.log(`Removals logged: ${removalLog.length}\n`);

// Save removal log
writeFileSync(
  'storage/audit/deterministic_removal_log.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    totalRemoved,
    removals: removalLog
  }, null, 2)
);

// Generate final report
let reportMd = `# DETERMINISTIC MISMATCH - FINAL REPORT\n\n`;
reportMd += `Generated: ${new Date().toISOString()}\n\n`;
reportMd += `## REMOVAL SUMMARY\n\n`;
reportMd += `| Metric | Value |\n`;
reportMd += `|--------|-------|\n`;
reportMd += `| Total deterministic removals | ${deterministicItems.length} |\n`;
reportMd += `| Total assets removed | ${totalRemoved} |\n`;
reportMd += `| Courses affected | ${new Set(removalLog.map(r => r.course)).size} |\n\n`;

reportMd += `## CRITERIA APPLIED\n\n`;
reportMd += `- Explicit "Aula XX" numbering in asset name\n`;
reportMd += `- >= 3 occurrences across lessons\n`;
reportMd += `- Mismatch diff >= 3 between asset aula number and lesson aula number\n\n`;

reportMd += `## REMOVED ASSETS\n\n`;
for (const r of removalLog) {
  reportMd += `- **${r.course}** > ${r.lesson}: ${r.asset}\n`;
  reportMd += `  - ${r.reason}\n\n`;
}

reportMd += `## SAFE ASSETS (not removed)\n\n`;
reportMd += `- 71 assets with safe patterns (workbook/apostila/template)\n`;
reportMd += `- 184 assets requiring human review\n\n`;

reportMd += `## ROLLBACK AVAILABLE\n\n`;
reportMd += `Backup location: ${rollbackDir}\n`;
reportMd += `To rollback: restore manifests from this directory\n`;

writeFileSync('storage/audit/deterministic_final_report.md', reportMd);

console.log('Files generated:');
console.log('  - deterministic_removal_log.json');
console.log('  - deterministic_final_report.md');
console.log('\n=== DONE ===');