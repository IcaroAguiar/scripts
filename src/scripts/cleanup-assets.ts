import { readFileSync, writeFileSync, readdirSync } from 'fs';

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

const MANIFESTS_DIR = 'storage/manifests/themembers';

function extractLessonNumber(lessonName: string): number | null {
  const match = lessonName.match(/Aula\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function extractAssetLessonNumbers(assetName: string): number[] {
  const matches = assetName.match(/Aula\s*(\d+)/gi) || [];
  return matches.map(m => {
    const num = m.match(/\d+/);
    return num ? parseInt(num[0]) : null;
  }).filter((n): n is number => n !== null);
}

function normalizeAssetName(name: string): string {
  return name.toLowerCase()
    .replace(/[À-ÿ]/gi, 'x')
    .replace(/[^a-z0-9\s._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldKeepAsset(assetName: string, lessonNumber: number | null, allAssetsInLesson: Asset[]): boolean {
  // Extract "Aula XX" numbers from asset name
  const assetNumbers = extractAssetLessonNumbers(assetName);

  if (assetNumbers.length === 0) {
    // No "Aula XX" in name - might be supplementary material
    // Check if this exact material (normalized) appears in multiple lessons
    // If so, it's likely a shared/global asset that shouldn't be here
    const normalized = normalizeAssetName(assetName);
    const duplicateCount = allAssetsInLesson.filter(a =>
      normalizeAssetName(a.name) === normalized
    ).length;

    // If this normalized name appears more than once in the same lesson, keep only one
    if (duplicateCount > 1) {
      return false; // Remove duplicate
    }

    // Keep assets without "Aula XX" - they might be legitimate shared materials
    return true;
  }

  // Asset has "Aula XX" - check if it matches the current lesson
  for (const assetNum of assetNumbers) {
    if (lessonNumber === null) {
      // Can't verify - keep it
      continue;
    }

    const diff = Math.abs(assetNum - lessonNumber);

    // If the asset's "Aula XX" number is more than 1 away from lesson number, it's likely wrong
    if (diff > 1) {
      return false;
    }
  }

  return true;
}

function cleanCourse(course: Course): { removed: number; cleaned: Lesson[] } {
  let totalRemoved = 0;
  const cleanedModules: Module[] = [];

  for (const mod of course.modules) {
    const cleanedLessons: Lesson[] = [];

    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') {
        cleanedLessons.push(lesson);
        continue;
      }

      const lessonNumber = extractLessonNumber(lesson.name);
      const originalAssetCount = lesson.assets.length;

      // Filter assets
      const cleanedAssets: Asset[] = [];
      const removedAssets: string[] = [];

      for (const asset of lesson.assets) {
        const keep = shouldKeepAsset(asset.name, lessonNumber, lesson.assets);

        if (keep) {
          // Check for exact duplicates (different encoding)
          const normalized = normalizeAssetName(asset.name);
          const alreadyAdded = cleanedAssets.some(a =>
            normalizeAssetName(a.name) === normalized
          );

          if (alreadyAdded) {
            removedAssets.push(asset.name + ' (exact duplicate)');
            totalRemoved++;
          } else {
            cleanedAssets.push(asset);
          }
        } else {
          removedAssets.push(asset.name);
          totalRemoved++;
        }
      }

      lesson.assets = cleanedAssets;
      cleanedLessons.push(lesson);

      if (removedAssets.length > 0) {
        console.log(`  ${lesson.name}: removed ${removedAssets.length} assets`);
        for (const r of removedAssets) {
          console.log(`    - ${r}`);
        }
      }
    }

    cleanedModules.push({ ...mod, lessons: cleanedLessons });
  }

  return { removed: totalRemoved, cleaned: cleanedModules.flatMap(m => m.lessons) };
}

async function main() {
  const files = readdirSync(MANIFESTS_DIR).filter(f => f.endsWith('.json'));

  let totalCourses = 0;
  let totalRemoved = 0;
  const results: { course: string; removed: number; status: string }[] = [];

  for (const file of files) {
    const raw = readFileSync(`${MANIFESTS_DIR}/${file}`, 'utf8');
    const course: Course = JSON.parse(raw);

    const cleanedModules = cleanCourse(course);

    // Write back
    writeFileSync(
      `${MANIFESTS_DIR}/${file}`,
      JSON.stringify({ ...course, modules: cleanedModules.cleanedModules || course.modules }, null, 2)
    );

    totalCourses++;
    totalRemoved += cleanedModules.removed;
    results.push({
      course: course.course,
      removed: cleanedModules.removed,
      status: cleanedModules.removed > 0 ? 'CLEANED' : 'OK'
    });
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Courses processed: ${totalCourses}`);
  console.log(`Total assets removed: ${totalRemoved}`);
  console.log(`\n=== BY COURSE ===`);
  for (const r of results.filter(x => x.removed > 0).sort((a, b) => b.removed - a.removed)) {
    console.log(`${r.status}: ${r.course} (${r.removed} removed)`);
  }
}

// Run
main().catch(console.error);
