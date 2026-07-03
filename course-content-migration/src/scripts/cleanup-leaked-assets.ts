import fs from 'fs-extra';
import path from 'node:path';
import { ManifestStore } from '../core/manifest/store';
import type { Asset, CourseManifest } from '../core/types';
import { runtimeContext, manifestStore } from './common';

interface AssetRef {
  name: string;
  url: string;
  moduleIndex: number;
  lessonIndex: number;
  lessonName: string;
}

const context = runtimeContext(true);
const store = manifestStore(context);

function normalizeAssetName(name: string): string {
  return name.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractLessonNumberFromAssetName(assetName: string): number | null {
  const match = assetName.match(/aula\s*(\d+)|(\d+)[°º]?\s*aula/i);
  if (match) return parseInt(match[1] || match[2], 10);
  return null;
}

function extractLessonNumberFromLessonName(lessonName: string): number | null {
  const match = lessonName.match(/aula\s*(\d+)|(\d+)[°º]?\s*/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

function shouldKeepAssetInLesson(assetName: string, lessonName: string): boolean {
  const assetLessonNum = extractLessonNumberFromAssetName(assetName);
  const lessonNum = extractLessonNumberFromLessonName(lessonName);

  if (assetLessonNum !== null && lessonNum !== null) {
    return assetLessonNum === lessonNum;
  }

  const assetWords = new Set(normalizeAssetName(assetName).split(' '));
  const lessonWords = new Set(normalizeAssetName(lessonName).split(' '));
  const intersection = [...assetWords].filter((w) => w.length > 3 && lessonWords.has(w));
  return intersection.length >= 2;
}

function isResolvedUrl(url: string): boolean {
  return !url.startsWith('unresolved://') && !url.startsWith('http');
}

async function cleanupCourseManifest(manifest: CourseManifest): Promise<{
  cleaned: number;
  removed: number;
  course: string;
}> {
  const nameToRefs = new Map<string, AssetRef[]>();
  const urlToRefs = new Map<string, AssetRef[]>();

  for (const [moduleIndex, mod] of manifest.modules.entries()) {
    for (const [lessonIndex, lesson] of mod.lessons.entries()) {
      for (const asset of lesson.assets) {
        const normalizedName = normalizeAssetName(asset.name);
        if (!nameToRefs.has(normalizedName)) nameToRefs.set(normalizedName, []);
        nameToRefs.get(normalizedName)!.push({
          name: asset.name,
          url: asset.url,
          moduleIndex,
          lessonIndex,
          lessonName: lesson.name
        });

        if (isResolvedUrl(asset.url)) {
          if (!urlToRefs.has(asset.url)) urlToRefs.set(asset.url, []);
          urlToRefs.get(asset.url)!.push({
            name: asset.name,
            url: asset.url,
            moduleIndex,
            lessonIndex,
            lessonName: lesson.name
          });
        }
      }
    }
  }

  const assetsToRemove = new Set<string>();

  for (const [url, refs] of urlToRefs) {
    if (refs.length > 1) {
      const firstRef = refs[0];
      for (let i = 1; i < refs.length; i += 1) {
        const key = `${refs[i].moduleIndex}-${refs[i].lessonIndex}-${refs[i].name}`;
        assetsToRemove.add(key);
      }
    }
  }

  for (const [name, refs] of nameToRefs) {
    if (refs.length > 1 && !refs.some((r) => isResolvedUrl(r.url))) {
      const unresolvedRefs = refs.filter((r) => !isResolvedUrl(r.url));
      const candidates = unresolvedRefs.filter((r) => shouldKeepAssetInLesson(r.name, r.lessonName));

      const toKeep = candidates.length > 0 ? candidates[0] : unresolvedRefs[0];

      for (const ref of unresolvedRefs) {
        if (ref === toKeep) continue;
        const key = `${ref.moduleIndex}-${ref.lessonIndex}-${ref.name}`;
        assetsToRemove.add(key);
      }
    }
  }

  let cleaned = 0;
  let removed = 0;

  for (const mod of manifest.modules) {
    for (const lesson of mod.lessons) {
      const originalCount = lesson.assets.length;
      lesson.assets = lesson.assets.filter((asset) => {
        const key = `${manifest.modules.indexOf(mod)}-${mod.lessons.indexOf(lesson)}-${asset.name}`;
        if (assetsToRemove.has(key)) {
          removed += 1;
          return false;
        }
        return true;
      });
      cleaned += lesson.assets.length;
    }
  }

  return { cleaned, removed, course: manifest.course };
}

async function main(): Promise<void> {
  const platform = process.env.CLEANUP_PLATFORM ?? 'themembers';
  const manifests = await store.listCourseManifests(platform);
  const dryRun = process.env.DRY_RUN === '1';

  console.log(`Platform: ${platform}`);
  console.log(`Manifests found: ${manifests.length}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');

  let totalCleaned = 0;
  let totalRemoved = 0;
  const results: Array<{ course: string; cleaned: number; removed: number }> = [];

  for (const manifestPath of manifests) {
    let manifest: CourseManifest;
    try {
      manifest = await store.readCourse(manifestPath);
    } catch {
      console.error(`Failed to read: ${manifestPath}`);
      continue;
    }

    if (manifest.modules.length === 0 || manifest.modules[0].lessons.length === 0) {
      continue;
    }

    const result = await cleanupCourseManifest(manifest);
    totalCleaned += result.cleaned;
    totalRemoved += result.removed;
    results.push(result);

    if (result.removed > 0) {
      console.log(`${result.course}: ${result.removed} assets removed, ${result.cleaned} retained`);
      if (!dryRun) {
        await store.saveCourse(manifest);
      }
    }
  }

  console.log('');
  console.log(`=== Summary ===`);
  console.log(`Total assets retained: ${totalCleaned}`);
  console.log(`Total assets removed: ${totalRemoved}`);
  console.log(`Courses affected: ${results.filter((r) => r.removed > 0).length}`);

  if (dryRun) {
    console.log('');
    console.log('DRY RUN - no changes saved. Run without DRY_RUN=1 to apply.');
  } else {
    console.log('');
    console.log('All manifests updated.');
  }
}

await main();