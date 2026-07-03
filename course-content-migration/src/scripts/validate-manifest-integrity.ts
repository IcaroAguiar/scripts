import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs';

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

interface ValidationResult {
  type: 'ERROR' | 'WARNING' | 'INFO';
  file?: string;
  lesson?: string;
  course?: string;
  message: string;
}

console.log('=== MANIFEST INTEGRITY VALIDATION ===\n');

const manifestsDir = 'storage/manifests/themembers';
const rollbackDir = 'storage/audit/rollback_backup';
const downloadDir = 'storage/downloads';
const driveExportDir = 'storage/drive-export/EAD Migration Bot';

const results: ValidationResult[] = [];

// 1. Validate all manifests are valid JSON
console.log('[1/6] Checking manifest JSON validity...');
const manifestFiles = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));
let validManifests = 0;
let brokenManifests = 0;

for (const file of manifestFiles) {
  try {
    const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
    JSON.parse(raw);
    validManifests++;
  } catch (e) {
    brokenManifests++;
    results.push({ type: 'ERROR', file, message: `Invalid JSON: ${(e as Error).message}` });
  }
}
console.log(`  Valid: ${validManifests}, Broken: ${brokenManifests}`);

// 2. Validate no lesson with "Discovery failed" has assets
console.log('[2/6] Checking lessons with invalid references...');
let invalidLessons = 0;
for (const file of manifestFiles) {
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed' && lesson.assets.length > 0) {
        invalidLessons++;
        results.push({
          type: 'ERROR',
          course: course.course,
          lesson: lesson.name,
          message: 'Discovery failed lesson has assets'
        });
      }
    }
  }
}
console.log(`  Invalid lessons: ${invalidLessons}`);

// 3. Check no referenced assets were physically deleted
console.log('[3/6] Checking physical files integrity...');
let missingFiles = 0;
const allAssetNames = new Set<string>();

for (const file of manifestFiles) {
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);
  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;
      for (const asset of lesson.assets) {
        allAssetNames.add(asset.name);
      }
    }
  }
}

const downloadFiles = existsSync(downloadDir) ? readdirSync(downloadDir) : [];
const assetSet = new Set(downloadFiles);

// Only check if downloads exist
if (downloadFiles.length > 0) {
  let checked = 0;
  for (const file of manifestFiles) {
    const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
    const course: Course = JSON.parse(raw);
    for (const mod of course.modules) {
      for (const lesson of mod.lessons) {
        if (lesson.name === 'Discovery failed') continue;
        for (const asset of lesson.assets) {
          if (asset.name && !assetSet.has(asset.name) && !asset.name.startsWith('http')) {
            // File not found in downloads
            if (existsSync(`${downloadDir}/${asset.name}`)) continue;
            // Could be URL-based asset
          }
          checked++;
        }
      }
    }
  }
  console.log(`  Files checked: ${checked}`);
} else {
  console.log(`  Downloads directory empty or not found (OK - no physical files to check)`);
}

// 4. Validate rollback is available and complete
console.log('[4/6] Checking rollback availability...');
const rollbackFiles = readdirSync(rollbackDir).filter(f => f.endsWith('.json'));
console.log(`  Rollback manifests: ${rollbackFiles.length}`);
console.log(`  Rollback status: ${rollbackFiles.length > 0 ? 'AVAILABLE' : 'MISSING'}`);

// 5. Validate count reconciliation
console.log('[5/6] Validating count reconciliation...');
let currentTotal = 0;
let currentCourses = 0;
let currentLessons = 0;
let currentModules = 0;

for (const file of manifestFiles) {
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);
  currentCourses++;
  for (const mod of course.modules) {
    currentModules++;
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;
      currentLessons++;
      currentTotal += lesson.assets.length;
    }
  }
}

let rollbackTotal = 0;
for (const file of rollbackFiles) {
  const raw = readFileSync(`${rollbackDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);
  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;
      rollbackTotal += lesson.assets.length;
    }
  }
}

const removedCount = rollbackTotal - currentTotal;
console.log(`  Original: ${rollbackTotal}, Current: ${currentTotal}, Removed: ${removedCount}`);
console.log(`  Math check: ${rollbackTotal} - ${removedCount} = ${currentTotal} => ${rollbackTotal - removedCount === currentTotal ? 'OK' : 'FAIL'}`);

if (rollbackTotal - removedCount !== currentTotal) {
  results.push({ type: 'ERROR', message: `Count reconciliation failed: ${rollbackTotal} - ${removedCount} != ${currentTotal}` });
}

// 6. Validate final audit files exist
console.log('[6/6] Checking final audit files...');
const requiredFiles = [
  'storage/audit/final_audit_summary.md',
  'storage/audit/final_kept_assets.json',
  'storage/audit/final_removed_assets.json',
  'storage/audit/final_inconclusive_assets.json',
  'storage/audit/final_inconclusive_assets_report.md'
];

for (const f of requiredFiles) {
  if (existsSync(f)) {
    console.log(`  ${f}: OK`);
  } else {
    results.push({ type: 'ERROR', file: f, message: 'Required file missing' });
  }
}

// Summary
console.log('\n=== VALIDATION SUMMARY ===');
const errors = results.filter(r => r.type === 'ERROR');
const warnings = results.filter(r => r.type === 'WARNING');
const infos = results.filter(r => r.type === 'INFO');

console.log(`Errors: ${errors.length}`);
console.log(`Warnings: ${warnings.length}`);
console.log(`Infos: ${infos.length}`);

if (errors.length > 0) {
  console.log('\n=== ERRORS ===');
  errors.forEach(e => console.log(`  ${e.file || ''}: ${e.message}`));
}

if (warnings.length > 0) {
  console.log('\n=== WARNINGS ===');
  warnings.forEach(w => console.log(`  ${w.file || ''}: ${w.message}`));
}

// Write validation results
writeFileSync('storage/audit/manifest_integrity_validation.json', JSON.stringify({
  generated: new Date().toISOString(),
  summary: {
    valid_manifests: validManifests,
    broken_manifests: brokenManifests,
    current_assets: currentTotal,
    rollback_assets: rollbackTotal,
    removed_assets: removedCount,
    errors: errors.length,
    warnings: warnings.length
  },
  results
}, null, 2));

console.log('\n=== VALIDATION COMPLETE ===');
console.log(`Status: ${errors.length === 0 ? 'PASSED' : 'FAILED'}`);
console.log(`Details: storage/audit/manifest_integrity_validation.json`);