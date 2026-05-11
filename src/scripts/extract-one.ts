import { ensureRuntimeDirs, manifestStore, platformAdapter, runtimeContext } from './common';

const manifestPath = process.env.EXTRACT_MANIFEST_PATH;
const moduleIndex = Number.parseInt(process.env.EXTRACT_MODULE_INDEX ?? '', 10);
const lessonIndex = Number.parseInt(process.env.EXTRACT_LESSON_INDEX ?? '', 10);
const force = process.env.EXTRACT_FORCE === '1';

if (!manifestPath || !Number.isInteger(moduleIndex) || !Number.isInteger(lessonIndex)) {
  throw new Error('EXTRACT_MANIFEST_PATH, EXTRACT_MODULE_INDEX and EXTRACT_LESSON_INDEX are required.');
}

const context = runtimeContext(true);
await ensureRuntimeDirs(context);

const store = manifestStore(context);
const adapter = platformAdapter();
const manifest = await store.readCourse(manifestPath);
const lesson = manifest.modules[moduleIndex]?.lessons[lessonIndex];

if (!lesson) {
  throw new Error(`Lesson not found at module ${moduleIndex}, lesson ${lessonIndex}.`);
}

if (!force && process.env.EXTRACT_FAILED_ONLY !== '1' && (lesson.assets.length > 0 || lesson.links.length > 0)) {
  process.exit(0);
}

try {
  const content = await adapter.extractLessonContent(context, lesson.url, lesson.name);
  lesson.description = content.description;
  lesson.links = content.links;
  lesson.assets = content.assets;
  lesson.status = 'discovered';
  lesson.lastError = undefined;
  await store.saveCourse(manifest);
  console.log(JSON.stringify({ course: manifest.course, lesson: lesson.name, assets: content.assets.length }));
} catch (error) {
  lesson.status = 'failed';
  lesson.lastError = error instanceof Error ? error.message : String(error);
  await store.saveCourse(manifest);
  throw error;
}
