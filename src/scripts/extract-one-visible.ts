import { ensureRuntimeDirs, manifestStore, platformAdapter, runtimeContext } from './common';

const manifestPath = process.env.EXTRACT_MANIFEST_PATH;
const moduleIndex = Number.parseInt(process.env.EXTRACT_MODULE_INDEX ?? '', 10);
const lessonIndex = Number.parseInt(process.env.EXTRACT_LESSON_INDEX ?? '', 10);
const force = process.env.EXTRACT_FORCE === '1';

if (!manifestPath || !Number.isInteger(moduleIndex) || !Number.isInteger(lessonIndex)) {
  throw new Error('EXTRACT_MANIFEST_PATH, EXTRACT_MODULE_INDEX and EXTRACT_LESSON_INDEX are required.');
}

const context = runtimeContext(false);
await ensureRuntimeDirs(context);

const store = manifestStore(context);
const adapter = platformAdapter();
const manifest = await store.readCourse(manifestPath);
const lesson = manifest.modules[moduleIndex]?.lessons[lessonIndex];

if (!lesson) {
  throw new Error(`Lesson not found at module ${moduleIndex}, lesson ${lessonIndex}.`);
}

if (!force && process.env.EXTRACT_FAILED_ONLY !== '1' && (lesson.assets.length > 0 || lesson.links.length > 0)) {
  console.log(JSON.stringify({ skipped: true, reason: 'already has assets/links', lesson: lesson.name }));
  process.exit(0);
}

const content = await adapter.extractLessonContent(context, lesson.url, lesson.name);
lesson.description = content.description;
lesson.links = content.links;
lesson.assets = content.assets;
lesson.status = 'discovered';
lesson.lastError = undefined;
await store.saveCourse(manifest);
console.log(JSON.stringify({ course: manifest.course, lesson: lesson.name, assets: content.assets.length }));

