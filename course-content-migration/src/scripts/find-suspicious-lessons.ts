import { ensureRuntimeDirs, runtimeContext, manifestStore } from './common';
import fs from 'fs-extra';
import path from 'node:path';

const context = runtimeContext(true);
await ensureRuntimeDirs(context);

const store = manifestStore(context);
const manifests = await store.listCourseManifests('themembers');

interface LessonRef {
  manifestPath: string;
  course: string;
  modIndex: number;
  lessonIndex: number;
  lessonName: string;
  assetNames: string[];
}

const allLessons: LessonRef[] = [];

for (const mPath of manifests) {
  const m = await store.readCourse(mPath);
  for (let mi = 0; mi < (m.modules?.length || 0); mi++) {
    const mod = m.modules[mi];
    for (let li = 0; li < (mod.lessons?.length || 0); li++) {
      const lesson = mod.lessons[li];
      if (lesson.name === 'Discovery failed') continue;
      
      allLessons.push({
        manifestPath: mPath,
        course: m.course,
        modIndex: mi,
        lessonIndex: li,
        lessonName: lesson.name,
        assetNames: lesson.assets.map(a => a.name)
      });
    }
  }
}

const urlMap = new Map<string, LessonRef[]>();
const nameMap = new Map<string, LessonRef[]>();

for (const lesson of allLessons) {
  const key = lesson.manifestPath + '|' + lesson.lessonName;
  for (const asset of lesson.assetNames) {
    if (!nameMap.has(key)) nameMap.set(key, []);
    nameMap.get(key)!.push(asset);
  }
}

const suspiciousLessons: LessonRef[] = [];

for (const lesson of allLessons) {
  const hasSuspiciousAssets = lesson.assetNames.some(name => {
    const numMatch = name.match(/Aula\s*(\d+)/i);
    if (!numMatch) return false;
    const assetNum = parseInt(numMatch[1]);
    const lessonNum = lesson.lessonName.match(/Aula\s*(\d+)/i);
    if (!lessonNum) return false;
    const currentNum = parseInt(lessonNum[1]);
    return Math.abs(assetNum - currentNum) > 2;
  });
  
  if (hasSuspiciousAssets) {
    suspiciousLessons.push(lesson);
  }
}

console.log(`Total lessons: ${allLessons.length}`);
console.log(`Lessons with suspicious assets: ${suspiciousLessons.length}`);
console.log('');

for (const lesson of suspiciousLessons.slice(0, 20)) {
  console.log(`${lesson.course} > ${lesson.lessonName}`);
  console.log(`  Assets: ${lesson.assetNames.join(', ')}`);
}