import { Logger } from '../core/logger/logger';
import { ensureRuntimeDirs, manifestStore, platformAdapter, runtimeContext } from './common';

const context = runtimeContext(true);
await ensureRuntimeDirs(context);

const adapter = platformAdapter();
const store = manifestStore(context);
const logger = new Logger(context.logsDir);

const id = process.env.DISCOVER_COURSE_ID;
const name = process.env.DISCOVER_COURSE_NAME;
const url = process.env.DISCOVER_COURSE_URL;

if (!id || !name || !url) {
  const missing = [];
  if (!id) missing.push('DISCOVER_COURSE_ID');
  if (!name) missing.push('DISCOVER_COURSE_NAME');
  if (!url) missing.push('DISCOVER_COURSE_URL');
  throw new Error(`[CONFIG_ERROR] Missing env vars: ${missing.join(', ')}. This is an orchestrator input error. discover-one was not started.`);
}

await logger.log('DISCOVER', `discovering course ${name}`, { url });
const manifest = await adapter.discoverCourse(context, { id, name, url });
const manifestPath = await store.saveCourse(manifest);
await logger.log('DISCOVER', `saved manifest ${manifestPath}`);
