import { ensureRuntimeDirs, platformAdapter, runtimeContext } from './common';

const context = runtimeContext(false);
await ensureRuntimeDirs(context);
await platformAdapter().login(context);
