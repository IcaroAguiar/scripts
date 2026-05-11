import fs from 'fs-extra';
import pLimit from 'p-limit';
import path from 'node:path';
import type { CourseManifest } from '../types';
import { assetTargetPath, writeLessonFiles } from '../filesystem/lesson-writer';
import { Logger } from '../logger/logger';
import { cleanName } from '../utils/slug';
import { withRetry } from '../utils/retry';
import { sha256File } from './hash';

function redactedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = parsed.search ? '?[redacted]' : '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

async function fetchToFile(url: string, targetPath: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while downloading asset`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(targetPath, bytes);
  } finally {
    clearTimeout(timeout);
  }
}

export class Downloader {
  constructor(
    private readonly downloadsDir: string,
    private readonly logsDir: string,
    private readonly concurrency: number
  ) {}

  async downloadCourse(manifest: CourseManifest): Promise<CourseManifest> {
    const logger = new Logger(this.logsDir);
    const limit = pLimit(this.concurrency);

    for (const mod of manifest.modules) {
      for (const lesson of mod.lessons) {
        await writeLessonFiles(this.downloadsDir, manifest, mod, lesson);
        await Promise.all(
          lesson.assets.map((asset) =>
            limit(async () => {
              if (asset.type === 'external-link') {
                asset.status = 'skipped';
                return;
              }

              const bucket = asset.type === 'audio' ? 'audios' : 'materiais';
              const targetPath = assetTargetPath(this.downloadsDir, manifest, mod, lesson, cleanName(asset.name), bucket);
              asset.targetPath = targetPath;
              asset.localPath = targetPath;

              if (asset.url.startsWith('unresolved://')) {
                asset.status = 'failed';
                asset.lastError = asset.lastError ?? 'Asset URL is unresolved and cannot be downloaded.';
                await logger.log('FAILED', `download skipped unresolved asset ${asset.name}`, { lesson: lesson.name });
                return;
              }

              if (await fs.pathExists(targetPath)) {
                asset.sha256 = await sha256File(targetPath);
                asset.status = 'skipped';
                await logger.log('SKIPPED', `already exists ${path.relative(this.downloadsDir, targetPath)}`);
                return;
              }

              await fs.ensureDir(path.dirname(targetPath));

              try {
                await withRetry(
                  async () => {
                    await fetchToFile(asset.url, targetPath, 120_000);
                  },
                  {
                    retries: 3,
                    baseDelayMs: 1_000,
                    onRetry: async (attempt, error) => {
                      await logger.log('RETRY', `download retry ${attempt}`, {
                        url: redactedUrl(asset.url),
                        error: error instanceof Error ? error.message : String(error)
                      });
                    }
                  }
                );
                asset.sha256 = await sha256File(targetPath);
                asset.status = 'downloaded';
                await logger.log('DOWNLOAD', `downloaded ${path.relative(this.downloadsDir, targetPath)}`);
              } catch (error) {
                asset.status = 'failed';
                asset.lastError = error instanceof Error ? error.message : String(error);
                await logger.log('FAILED', `download failed ${redactedUrl(asset.url)}`, { error: asset.lastError });
              }
            })
          )
        );
      }
    }

    return manifest;
  }
}
