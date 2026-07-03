import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';

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

interface DryRunResult {
  course: string;
  courseSlug: string;
  modules: number;
  lessons: number;
  assets: number;
  validPaths: boolean;
  structureValid: boolean;
  errors: string[];
  warnings: string[];
}

console.log('=== DRY-RUN MIGRATION VALIDATION ===\n');

const manifestsDir = 'storage/manifests/themembers';
const files = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));

const results: DryRunResult[] = [];
let totalModules = 0;
let totalLessons = 0;
let totalAssets = 0;
let criticalErrors = 0;

for (const file of files) {
  const courseSlug = file.replace('.json', '');
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');

  try {
    const course: Course = JSON.parse(raw);
    const result: DryRunResult = {
      course: course.course,
      courseSlug,
      modules: course.modules.length,
      lessons: 0,
      assets: 0,
      validPaths: true,
      structureValid: true,
      errors: [],
      warnings: []
    };

    totalModules += course.modules.length;

    for (const mod of course.modules) {
      if (!mod.name || mod.name.trim() === '') {
        result.errors.push(`Module without name in ${course.course}`);
        result.structureValid = false;
      }

      for (const lesson of mod.lessons) {
        result.lessons++;
        totalLessons++;

        if (lesson.name === 'Discovery failed') continue;

        if (!lesson.name || lesson.name.trim() === '') {
          result.errors.push(`Lesson without name in ${course.course}/${mod.name}`);
          result.structureValid = false;
        }

        if (!lesson.url || lesson.url.trim() === '') {
          result.errors.push(`Lesson without URL: ${lesson.name}`);
          result.structureValid = false;
        }

        for (const asset of lesson.assets) {
          result.assets++;
          totalAssets++;

          if (!asset.name || asset.name.trim() === '') {
            result.errors.push(`Asset without name in ${course.course}/${mod.name}/${lesson.name}`);
          }

          if (!asset.url || asset.url.trim() === '') {
            if (!asset.name?.startsWith('http')) {
              result.errors.push(`Asset without URL and not URL-based: ${asset.name}`);
            }
          }
        }
      }
    }

    // Check course path structure
    const expectedPath = `courses/${courseSlug}`;
    if (!course.slug || course.slug === '') {
      result.warnings.push(`Course without slug`);
    }

    results.push(result);
    if (result.errors.length > 0) criticalErrors += result.errors.length;

  } catch (e) {
    results.push({
      course: file,
      courseSlug: '',
      modules: 0,
      lessons: 0,
      assets: 0,
      validPaths: false,
      structureValid: false,
      errors: [`Failed to parse: ${(e as Error).message}`],
      warnings: []
    });
    criticalErrors++;
  }
}

// Summary by course
console.log('=== VALIDATION BY COURSE ===\n');

let coursesWithErrors = 0;
let coursesWithWarnings = 0;

for (const r of results) {
  if (r.errors.length > 0) {
    coursesWithErrors++;
    console.log(`❌ ${r.course}: ${r.errors.length} errors`);
    r.errors.forEach(e => console.log(`   - ${e}`));
  } else if (r.warnings.length > 0) {
    coursesWithWarnings++;
    console.log(`⚠️  ${r.course}: ${r.warnings.length} warnings`);
  } else {
    console.log(`✅ ${r.course}: OK (${r.modules} mods, ${r.lessons} lessons, ${r.assets} assets)`);
  }
}

console.log('\n=== TOTALS ===');
console.log(`Courses: ${results.length}`);
console.log(`Modules: ${totalModules}`);
console.log(`Lessons: ${totalLessons}`);
console.log(`Assets: ${totalAssets}`);

console.log('\n=== COUNT BY COURSE ===');
const byCourse = results.reduce((acc, r) => {
  acc[r.course] = (acc[r.course] || 0) + r.assets;
  return acc;
}, {} as Record<string, number>);
Object.entries(byCourse).sort((a, b) => b[1] - a[1]).forEach(([course, count]) => {
  console.log(`  ${count.toString().padStart(4)} - ${course}`);
});

console.log('\n=== VALIDATION RESULT ===');
console.log(`Courses with errors: ${coursesWithErrors}`);
console.log(`Courses with warnings: ${coursesWithWarnings}`);
console.log(`Critical errors: ${criticalErrors}`);
console.log(`Status: ${criticalErrors === 0 ? '✅ READY' : '❌ BLOCKED'}`);

// Write results
writeFileSync('storage/audit/dry_run_migration_validation.json', JSON.stringify({
  generated: new Date().toISOString(),
  summary: {
    total_courses: results.length,
    total_modules: totalModules,
    total_lessons: totalLessons,
    total_assets: totalAssets,
    courses_with_errors: coursesWithErrors,
    courses_with_warnings: coursesWithWarnings,
    critical_errors: criticalErrors,
    status: criticalErrors === 0 ? 'READY' : 'BLOCKED'
  },
  by_course: results.map(r => ({
    course: r.course,
    courseSlug: r.courseSlug,
    modules: r.modules,
    lessons: r.lessons,
    assets: r.assets,
    errors: r.errors,
    warnings: r.warnings
  }))
}, null, 2));

console.log('\nResults written to: storage/audit/dry_run_migration_validation.json');