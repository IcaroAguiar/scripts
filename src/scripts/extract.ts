import path from 'node:path';
import { ensureRuntimeDirs, env, manifestStore, runtimeContext } from './common';
import type { CourseManifest, LessonManifest } from '../core/types';
import { Logger } from '../core/logger/logger';

function lessonHasPendingExtraction(lesson: LessonManifest, force: boolean): boolean {
  if (process.env.EXTRACT_FAILED_ONLY === '1') {
    return lesson.status === 'failed' && lesson.name !== 'Discovery failed';
  }
  if (force) return true;
  if (lesson.status === 'failed' && lesson.lastError && !force) return false;
  return lesson.assets.length === 0 && lesson.links.length === 0;
}

function countLessons(manifest: CourseManifest, force: boolean): number {
  return manifest.modules.reduce(
    (total, mod) => total + mod.lessons.filter((lesson) => lessonHasPendingExtraction(lesson, force)).length,
    0
  );
}

async function runLessonWorker(envVars: Record<string, string>, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn(['bun', 'run', 'src/scripts/extract-one.ts'], {
    env: { ...process.env, ...envVars },
    stdout: 'pipe',
    stderr: 'pipe'
  });

  const outputPromise = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let timeout: Timer | undefined;

  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<number>((resolve) => {
        timeout = setTimeout(() => {
          child.kill();
          resolve(124);
        }, timeoutMs);
      })
    ]);
    const [stdout, stderr] = await outputPromise;
    return { ok: exitCode === 0, output: [stdout, stderr].filter(Boolean).join('\n').trim() };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const context = runtimeContext(true);
await ensureRuntimeDirs(context);

const runtimeEnv = env();
const force = process.env.EXTRACT_FORCE === '1';
const maxCourses = Number.parseInt(process.env.EXTRACT_MAX_COURSES ?? '', 10);
const timeoutMs = Number.parseInt(process.env.EXTRACT_LESSON_TIMEOUT_MS ?? '45000', 10);
const courseSlug = process.env.EXTRACT_COURSE_SLUG;
const store = manifestStore(context);
const logger = new Logger(context.logsDir);
const manifestPaths = await store.listCourseManifests(context.platform);

let processedCourses = 0;
let processedLessons = 0;
let failedLessons = 0;

for (const manifestPath of manifestPaths) {
  let manifest = await store.readCourse(manifestPath);
  if (runtimeEnv.THEMEMBERS_COURSE_URL && manifest.url !== runtimeEnv.THEMEMBERS_COURSE_URL) continue;
  if (courseSlug && manifest.slug !== courseSlug) continue;

  const pendingCount = countLessons(manifest, force);
  if (pendingCount === 0) continue;
  if (Number.isFinite(maxCourses) && processedCourses >= maxCourses) break;

  processedCourses += 1;
  await logger.log('DISCOVER', `extracting course lessons`, {
    course: manifest.course,
    lessons: pendingCount
  });

  let courseLessons = 0;
  let courseAssets = 0;
  let courseFailures = 0;

  for (const [moduleIndex, mod] of manifest.modules.entries()) {
    for (const [lessonIndex, lesson] of mod.lessons.entries()) {
      if (!lessonHasPendingExtraction(lesson, force)) continue;
      courseLessons += 1;
      processedLessons += 1;

      const result = await runLessonWorker(
        {
          EXTRACT_MANIFEST_PATH: path.resolve(manifestPath),
          EXTRACT_MODULE_INDEX: String(moduleIndex),
          EXTRACT_LESSON_INDEX: String(lessonIndex),
          EXTRACT_FORCE: force ? '1' : '0',
          EXTRACT_COURSE_URL: manifest.url,
          EXTRACT_HOMEPAGE_FIRST:
            process.env.EXTRACT_HOMEPAGE_FIRST === '1' || lesson.status === 'failed' ? '1' : '0'
        },
        timeoutMs
      );

      manifest = await store.readCourse(manifestPath);
      const updatedLesson = manifest.modules[moduleIndex]?.lessons[lessonIndex];
      const assets = updatedLesson?.assets.length ?? 0;

      if (result.ok) {
        courseAssets += assets;
        await logger.log('DISCOVER', `lesson worker completed`, {
          course: manifest.course,
          lesson: updatedLesson?.name ?? lesson.name,
          assets
        });
      } else {
        failedLessons += 1;
        courseFailures += 1;
        if (updatedLesson && !updatedLesson.lastError) {
          updatedLesson.status = 'failed';
          updatedLesson.lastError =
            result.output || `Lesson extraction worker timed out after ${timeoutMs}ms or exited with an error.`;
          await store.saveCourse(manifest);
        }
        await logger.log('FAILED', `lesson worker failed`, {
          course: manifest.course,
          lesson: updatedLesson?.name ?? lesson.name,
          error: result.output || `timeout after ${timeoutMs}ms`
        });
      }
    }
  }

  await logger.log('DISCOVER', `finished course lesson extraction`, {
    course: manifest.course,
    lessons: courseLessons,
    assets: courseAssets,
    failures: courseFailures
  });
}

await logger.log('DISCOVER', `finished lesson extraction batch`, {
  courses: processedCourses,
  lessons: processedLessons,
  failures: failedLessons
});
