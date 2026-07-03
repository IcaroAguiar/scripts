import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync, mkdirSync, copyFileSync, constants } from 'fs';
import { join, basename } from 'path';
import { numberedName, cleanName } from '../core/utils/slug';
import type { CourseManifest, Module, Lesson } from '../core/types';

const DRIVE_EXPORT_DIR = 'storage/drive-export';
const DRIVE_ROOT_FOLDER_NAME = 'EAD Migration Bot';
const DOWNLOADS_DIR = 'storage/downloads';
const MANIFESTS_DIR = 'storage/manifests/themembers';

console.log('=== REGENERATE CLEAN STAGING (DIRECT COPY) ===\n');

const stagingPath = join(DRIVE_EXPORT_DIR, DRIVE_ROOT_FOLDER_NAME, 'themembers');

// 1. Remove old staging
if (existsSync(stagingPath)) {
  console.log('[1/4] Removing old staging...');
  rmSync(stagingPath, { recursive: true, force: true });
}
mkdirSync(stagingPath, { recursive: true });
console.log('  ✓ Old staging removed\n');

// 2. Load all clean manifests
console.log('[2/4] Loading clean manifests...');
const manifestFiles = readdirSync(MANIFESTS_DIR).filter(f => f.endsWith('.json'));
const manifests: CourseManifest[] = [];

for (const file of manifestFiles) {
  try {
    const raw = readFileSync(join(MANIFESTS_DIR, file), 'utf8');
    manifests.push(JSON.parse(raw));
  } catch (e) {
    console.log(`  ⚠ Failed to parse ${file}: ${(e as Error).message}`);
  }
}
console.log(`  ✓ Loaded ${manifests.length} manifests\n`);

// 3. Copy files from downloads to staging
console.log('[3/4] Copying files to staging...');
let coursesProcessed = 0;
let lessonsProcessed = 0;
let filesCopied = 0;
let filesFailed = 0;

for (const manifest of manifests) {
  const courseSlug = manifest.slug || cleanName(manifest.course).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const courseDir = join(stagingPath, manifest.course);

  for (const mod of manifest.modules) {
    const modDirName = numberedName(mod.index, mod.name);
    const modDir = join(courseDir, modDirName);

    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;

      const lessonDirName = numberedName(lesson.index, lesson.name);
      const lessonDir = join(modDir, lessonDirName);

      // Source dir pattern: downloadsDir/platform/course/ModuleName/LessonName
      const sourceCourseDir = join(DOWNLOADS_DIR, manifest.platform, cleanName(manifest.course).replace(/^01 - /, ''));
      const sourceModDir = join(sourceCourseDir, modDirName);
      const sourceLessonDir = join(sourceModDir, lessonDirName);

      if (!existsSync(sourceLessonDir)) {
        // Try alternative path patterns
        const altPaths = [
          join(DOWNLOADS_DIR, manifest.platform, numberedName(1, manifest.course).replace(/^01 - /, ''), modDirName, lessonDirName),
          join(DOWNLOADS_DIR, manifest.platform, manifest.course, modDirName, lessonDirName),
        ];

        let found = false;
        for (const alt of altPaths) {
          if (existsSync(alt)) {
            mkdirSync(lessonDir, { recursive: true });
            copyDirRecursive(alt, lessonDir);
            filesCopied += countFiles(lessonDir);
            found = true;
            break;
          }
        }

        if (!found) {
          filesFailed++;
        }
      } else {
        mkdirSync(lessonDir, { recursive: true });
        copyDirRecursive(sourceLessonDir, lessonDir);
        filesCopied += countFiles(lessonDir);
      }

      lessonsProcessed++;
    }
  }

  coursesProcessed++;
}

console.log(`  ✓ Copied ${filesCopied} files`);
if (filesFailed > 0) console.log(`  ⚠ ${filesFailed} lesson dirs not found in downloads`);
console.log(`  Courses: ${coursesProcessed}, Lessons: ${lessonsProcessed}\n`);

// 4. Copy manifests
console.log('[4/4] Copying manifests to _manifests...');
const manifestsDir = join(stagingPath, '_manifests');
mkdirSync(manifestsDir, { recursive: true });

for (const manifest of manifests) {
  const filePath = join(manifestsDir, `${manifest.slug}.json`);
  writeFileSync(filePath, JSON.stringify(manifest, null, 2));
}
console.log(`  ✓ Copied ${manifests.length} manifests\n`);

console.log('=== RESULT ===');
console.log(`Staging path: ${stagingPath}`);
console.log(`Courses: ${coursesProcessed}`);
console.log(`Lessons: ${lessonsProcessed}`);
console.log(`Files copied: ${filesCopied}`);
console.log(`\n✓ Clean staging ready!`);

function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(src)) return;

  const entries = readdirSync(src, { withFileTypes: true });
  mkdirSync(dest, { recursive: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      try {
        copyFileSync(srcPath, destPath, constants.COPYFILE_EXCL);
      } catch (e) {
        // File already exists, skip
      }
    }
  }
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += countFiles(join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}