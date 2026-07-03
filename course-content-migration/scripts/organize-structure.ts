import fs from 'fs-extra';
import path from 'path';

const OUTPUT_BASE = 'storage/releases/themembers-v3-repaired/cursos';
const MANIFESTS_DIR = 'storage/manifests/themembers-v3-repaired';

async function main() {
  console.log('=== Organizing Root Files into Module/Lesson Structure ===\n');

  const courses = fs.readdirSync(OUTPUT_BASE).filter(c => c !== '.DS_Store');

  let totalMoved = 0;
  let coursesFixed = 0;

  for (const courseSlug of courses) {
    const courseDir = path.join(OUTPUT_BASE, courseSlug);
    const manifestPath = path.join(MANIFESTS_DIR, courseSlug + '.json');

    // Get root-level zip/pdf files
    let rootFiles = [];
    try {
      for (const e of fs.readdirSync(courseDir)) {
        if (e === '.DS_Store') continue;
        const f = path.join(courseDir, e);
        if (fs.statSync(f).isFile() && e.match(/\.(zip|pdf)$/i)) {
          rootFiles.push(e);
        }
      }
    } catch { continue; }

    if (rootFiles.length === 0) continue;

    // Load manifest to get module/lesson structure
    let modules = [];
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        modules = manifest.modules || [];
      } catch {}
    }

    // Build a map: material name -> [moduleName, lessonName]
    const materialMap: Map<string, { module: string; lesson: string }> = new Map();
    for (const mod of modules) {
      for (const lesson of (mod.lessons || [])) {
        for (const asset of (lesson.assets || [])) {
          if (asset.name) {
            materialMap.set(asset.name.toLowerCase(), {
              module: mod.name,
              lesson: lesson.name
            });
          }
        }
      }
    }

    // Try to match each root file to a module/lesson
    let moved = 0;
    for (const fileName of rootFiles) {
      // Try exact match first
      let match = materialMap.get(fileName.toLowerCase());

      // Try partial match (file contains material name)
      if (!match) {
        for (const [matName, pos] of materialMap) {
          if (fileName.toLowerCase().includes(matName) || matName.includes(fileName.toLowerCase().replace('.pdf','').replace('.zip',''))) {
            match = pos;
            break;
          }
        }
      }

      // Try numeric pattern match (Aula 01, Aula 02, etc.)
      if (!match) {
        const aulaMatch = fileName.match(/Aula\s*(\d+)/i) || fileName.match(/aula\s*(\d+)/i);
        if (aulaMatch) {
          const aulaNum = parseInt(aulaMatch[1]);
          for (const mod of modules) {
            for (const lesson of (mod.lessons || [])) {
              if (lesson.name && lesson.name.toLowerCase().includes(`aula ${aulaNum}`)) {
                match = { module: mod.name, lesson: lesson.name };
                break;
              }
            }
            if (match) break;
          }
        }
      }

      // Last resort: put in first module/first lesson
      if (!match && modules.length > 0) {
        const firstLesson = modules[0].lessons?.[0];
        if (firstLesson) {
          match = { module: modules[0].name, lesson: firstLesson.name };
        }
      }

      if (match) {
        const safeModule = match.module.replace(/[<>:"/\\|?*]/g, '_').substring(0, 80);
        const safeLesson = match.lesson.replace(/[<>:"/\\|?*]/g, '_').substring(0, 80);
        const destDir = path.join(courseDir, safeModule, safeLesson, 'materiais');
        const src = path.join(courseDir, fileName);
        const dest = path.join(destDir, fileName);

        fs.ensureDirSync(destDir);
        fs.renameSync(src, dest);
        moved++;
        console.log(`MOVE ${courseSlug}: ${fileName} -> ${safeModule}/${safeLesson}`);
      } else {
        console.log(`UNMATCHED ${courseSlug}: ${fileName}`);
      }
    }

    if (moved > 0) {
      totalMoved += moved;
      coursesFixed++;
    }
  }

  console.log(`\n=== Result ===`);
  console.log(`Courses fixed: ${coursesFixed}`);
  console.log(`Files organized: ${totalMoved}`);
}

main().catch(console.error);