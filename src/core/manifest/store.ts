import fs from 'fs-extra';
import path from 'node:path';
import type { CourseManifest, CourseRef, PlatformId } from '../types';
import { courseIndexSchema, courseManifestSchema } from './schema';

export class ManifestStore {
  constructor(private readonly manifestDir: string) {}

  async saveIndex(platform: PlatformId, courses: CourseRef[]): Promise<string> {
    await fs.ensureDir(this.manifestDir);
    const filePath = path.join(this.manifestDir, `${platform}-index.json`);
    const payload = courseIndexSchema.parse({
      platform,
      discoveredAt: new Date().toISOString(),
      courses
    });
    await fs.writeJson(filePath, payload, { spaces: 2 });
    return filePath;
  }

  async saveCourse(manifest: CourseManifest): Promise<string> {
    const parsed = courseManifestSchema.parse(manifest);
    const platformDir = path.join(this.manifestDir, manifest.platform);
    await fs.ensureDir(platformDir);
    const filePath = path.join(platformDir, `${manifest.slug}.json`);
    await fs.writeJson(filePath, parsed, { spaces: 2 });
    return filePath;
  }

  async readCourse(filePath: string): Promise<CourseManifest> {
    return courseManifestSchema.parse(await fs.readJson(filePath));
  }

  async listCourseManifests(platform: PlatformId): Promise<string[]> {
    const platformDir = path.join(this.manifestDir, platform);
    if (!(await fs.pathExists(platformDir))) return [];
    return (await fs.readdir(platformDir))
      .filter((file) => file.endsWith('.json'))
      .map((file) => path.join(platformDir, file));
  }
}
