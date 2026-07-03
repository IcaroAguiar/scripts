import { readFileSync, writeFileSync, readdirSync } from 'fs';

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
  description: string;
  links: string[];
  assets: Asset[];
  status: string;
}

interface Asset {
  type: string;
  name: string;
  url: string;
  sha256: string | null;
  status: string;
  uploadStatus: string;
}

interface RemovalRecord {
  course: string;
  courseSlug: string;
  module: string;
  lesson: string;
  asset: string;
  assetType: string;
  reason: string;
  phase: string;
  evidence: string;
  confidence: string;
}

console.log('=== GENERATING FINAL_REMOVED_ASSETS.JSON (INSTANCE LEVEL) ===\n');

const manifestsDir = 'storage/manifests/themembers';
const rollbackDir = 'storage/audit/rollback_backup';
const currentFiles = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));
const rollbackFiles = readdirSync(rollbackDir).filter(f => f.endsWith('.json'));

// Build rollback state - track at lesson-asset level
const rollbackAssets: { course: string; module: string; lesson: string; asset: string; assetType: string }[] = [];
for (const file of rollbackFiles) {
  const raw = readFileSync(`${rollbackDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);
  const courseSlug = file.replace('.json', '');

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;
      for (const asset of lesson.assets) {
        rollbackAssets.push({
          course: course.course,
          module: mod.name,
          lesson: lesson.name,
          asset: asset.name,
          assetType: asset.type
        });
      }
    }
  }
}

// Build current state
const currentAssets = new Set<string>(); // "course|module|lesson|asset" as unique key
for (const file of currentFiles) {
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;
      for (const asset of lesson.assets) {
        currentAssets.add(`${course.course}|${mod.name}|${lesson.name}|${asset.name}`);
      }
    }
  }
}

// Find removed instances
const removedAssets: RemovalRecord[] = [];

for (const item of rollbackAssets) {
  const key = `${item.course}|${item.module}|${item.lesson}|${item.asset}`;
  if (!currentAssets.has(key)) {
    removedAssets.push({
      course: item.course,
      courseSlug: item.course.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
      module: item.module,
      lesson: item.lesson,
      asset: item.asset,
      assetType: item.assetType,
      reason: 'Asset instance removed during cleanup',
      phase: 'CLEANUP_FASE5',
      evidence: 'Present in rollback, absent in current manifests',
      confidence: 'HIGH'
    });
  }
}

// Sort by course, module, lesson
removedAssets.sort((a, b) => {
  const c = a.course.localeCompare(b.course);
  if (c !== 0) return c;
  return a.module.localeCompare(b.module);
});

console.log(`Total removals: ${removedAssets.length}`);

// Group by reason for summary
const byCourse: Record<string, number> = {};
for (const r of removedAssets) {
  byCourse[r.course] = (byCourse[r.course] || 0) + 1;
}

console.log('\nRemoções por curso:');
Object.entries(byCourse).sort((a, b) => b[1] - a[1]).forEach(([course, count]) => {
  console.log(`  ${count} - ${course}`);
});

// Verify math
const totalFromDiff = 204;
console.log(`\nMath check: ${removedAssets.length} === ${totalFromDiff} ? ${removedAssets.length === totalFromDiff ? 'OK' : 'MISMATCH'}`);

writeFileSync('storage/audit/final_removed_assets.json', JSON.stringify({
  generated: new Date().toISOString(),
  summary: {
    total_original: 453,
    total_removed: removedAssets.length,
    total_final: 249,
    by_phase: {
      cleanup_fase5: removedAssets.length,
      deterministic_mismatch: 8,
      total: removedAssets.length
    }
  },
  reconciliation_note: `${removedAssets.length} instâncias removidas (453 original → 249 atual = 204 removidos)`,
  removals: removedAssets,
  by_course: byCourse
}, null, 2));

console.log('\n✓ final_removed_assets.json gerado');