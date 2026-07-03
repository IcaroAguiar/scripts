import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROLLBACK = '/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/audit/rollback_backup';
const V3 = '/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/manifests/themembers-v3';
const REPAIRED = '/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/manifests/themembers-v3-repaired';

const P0_COURSES = [
  'alta-performance-com-gustavo-borges.json',
  'analises-avancadas-com-python-mba.json',
  'clickup-para-gestores.json',
  'design-de-dashboards-e-storytelling-com-dados.json',
  'excel-avancado.json',
  'excel-essencial.json',
  'figma.json',
  'linkedin-estrategico.json',
  'mentoria-analise-de-perfil-do-linkedin.json',
];

const p0Set = new Set(P0_COURSES);

if (!fs.existsSync(REPAIRED)) {
  fs.mkdirSync(REPAIRED, { recursive: true });
}

const v3Files = fs.readdirSync(V3).filter(f => f.endsWith('.json'));
console.log(`Found ${v3Files.length} manifests in themembers-v3/`);

const rollbackFiles = fs.readdirSync(ROLLBACK).filter(f => f.endsWith('.json'));
console.log(`Found ${rollbackFiles.length} manifests in rollback_backup/`);

let restored = [];
let copied = [];

for (const file of v3Files) {
  const dest = path.join(REPAIRED, file);
  let source;

  if (p0Set.has(file)) {
    source = path.join(ROLLBACK, file);
    if (fs.existsSync(source)) {
      const data = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (!data.discoveredAt) {
        data.discoveredAt = new Date().toISOString();
      }
      fs.writeFileSync(dest, JSON.stringify(data, null, 2));
      restored.push(file);
    } else {
      console.warn(`  WARN: ${file} not found in rollback_backup, copying from v3`);
      fs.copyFileSync(path.join(V3, file), dest);
      copied.push(file);
    }
  } else {
    source = path.join(V3, file);
    fs.copyFileSync(source, dest);
    copied.push(file);
  }
}

console.log(`\n=== Summary ===`);
console.log(`Restored from rollback_backup (${restored.length}):`);
restored.forEach(f => console.log(`  + ${f}`));
console.log(`\nCopied as-is from themembers-v3 (${copied.length}):`);
copied.forEach(f => console.log(`  + ${f}`));
console.log(`\nTotal in themembers-v3-repaired/: ${restored.length + copied.length}`);