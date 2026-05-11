import { ensureRuntimeDirs, runtimeContext, manifestStore } from './common';

const context = runtimeContext(true);
await ensureRuntimeDirs(context);

const store = manifestStore(context);

const SUSPICIOUS = [
  { slug: 'canva', lessonPattern: 'Aula 03' },
  { slug: 'excel-avancado', lessonPattern: 'Aula 0' },
  { slug: 'figma', lessonPattern: 'Aula 01' },
  { slug: 'figma', lessonPattern: 'Aula 04' },
  { slug: 'gestao-de-tempo-e-produtividade', lessonPattern: 'AULA 02' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 06' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 10' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 13' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 14' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 16' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 18' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 20' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 21' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 22' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 23' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 25' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 26' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 28' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 29' },
  { slug: 'ingles-para-iniciantes', lessonPattern: 'Aula 31' },
];

const MAX_PARALLEL = 2;
let running = 0;
let done = 0;
const coursesToProcess = new Set(SUSPICIOUS.map(s => s.slug));

for (const courseSlug of coursesToProcess) {
  const manifestPath = `storage/manifests/themembers/${courseSlug}.json`;
  console.log(`Re-extracting course: ${courseSlug}`);
  
  while (running >= MAX_PARALLEL) {
    await new Promise(r => setTimeout(r, 500));
  }
  
  running++;
  
  const child = Bun.spawn(['bun', 'run', 'src/scripts/extract-one.ts'], {
    env: {
      ...process.env,
      EXTRACT_MANIFEST_PATH: manifestPath,
      EXTRACT_FORCE: '1'
    },
    stdout: 'pipe',
    stderr: 'pipe'
  });
  
  child.exited.then((code) => {
    running--;
    done++;
    console.log(`[${done}/${coursesToProcess}] ${courseSlug} - ${code === 0 ? 'OK' : 'FAILED'}`);
  });
}

console.log('\nAguardando completamento...');

await new Promise(r => setTimeout(r, 60000));
console.log('Done (check manifests for results)');