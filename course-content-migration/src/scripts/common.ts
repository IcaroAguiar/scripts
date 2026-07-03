import path from 'node:path';
import fs from 'fs-extra';
import { createTheMembersAdapter, themembersAuthStatePath } from '../config/platforms/themembers';
import { loadEnv } from '../core/config/env';
import { ManifestStore } from '../core/manifest/store';
import type { PlatformAdapter, RuntimeContext } from '../core/types';

export function runtimeContext(headless = true): RuntimeContext {
  return {
    platform: 'themembers',
    headless,
    authStatePath: themembersAuthStatePath,
    manifestDir: path.join('storage', 'manifests'),
    downloadsDir: path.join('storage', 'downloads'),
    logsDir: path.join('storage', 'logs')
  };
}

export function platformAdapter(): PlatformAdapter {
  return createTheMembersAdapter();
}

export function manifestStore(context: RuntimeContext): ManifestStore {
  return new ManifestStore(context.manifestDir);
}

export async function ensureRuntimeDirs(context: RuntimeContext): Promise<void> {
  await Promise.all([
    fs.ensureDir(path.dirname(context.authStatePath)),
    fs.ensureDir(context.manifestDir),
    fs.ensureDir(context.downloadsDir),
    fs.ensureDir(context.logsDir)
  ]);
}

export function env() {
  return loadEnv();
}
