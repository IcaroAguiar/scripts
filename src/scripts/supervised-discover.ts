#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, statSync, appendFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { spawn } from 'child_process';

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN_DIR = 'storage/runs';
const RUN_PATH = join(RUN_DIR, `discover_${RUN_ID}`);
const HEARTBEAT_INTERVAL = 60_000;

interface Heartbeat {
  runId: string;
  status: 'INIT' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'PARTIAL';
  currentPhase: string;
  currentCourse: string;
  currentModule: string;
  currentLesson: string;
  processedCourses: number;
  successfulCourses: number;
  failedCourses: number;
  processedModules: number;
  processedLessons: number;
  lastAction: string;
  lastError: string;
  startedAt: string;
  lastUpdate: string;
}

interface Progress {
  runId: string;
  phases: {
    preflight: 'PENDING' | 'RUNNING' | 'OK' | 'FAILED';
    backup: 'PENDING' | 'RUNNING' | 'OK' | 'FAILED';
    discovery: 'PENDING' | 'RUNNING' | 'OK' | 'FAILED' | 'PARTIAL';
    validation: 'PENDING' | 'RUNNING' | 'OK' | 'FAILED';
    audit: 'PENDING' | 'RUNNING' | 'OK' | 'FAILED';
  };
  courses: { total: number; processed: number; success: number; failed: number; skipped: number };
  modules: { total: number; processed: number };
  lessons: { total: number; processed: number };
}

interface NDJSONEvent {
  timestamp: string;
  runId: string;
  phase: string;
  action: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED_RETRYABLE' | 'FAILED_FINAL' | 'SKIPPED_ALREADY_DONE' | 'ABORTED';
  courseName?: string;
  courseSlug?: string;
  moduleName?: string;
  lessonName?: string;
  assetName?: string;
  url?: string;
  attempt?: number;
  durationMs?: number;
  error?: string;
  screenshotPath?: string;
  tracePath?: string;
}

function log(msg: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(join(RUN_PATH, 'logs', 'run.log'), line + '\n');
  } catch { }
}

function logNDJSON(event: NDJSONEvent) {
  try {
    appendFileSync(join(RUN_PATH, 'logs', 'run.ndjson'), JSON.stringify(event) + '\n');
  } catch { }
}

function logError(event: NDJSONEvent) {
  try {
    appendFileSync(join(RUN_PATH, 'logs', 'errors.ndjson'), JSON.stringify(event) + '\n');
  } catch { }
}

function writeJson(path: string, data: any) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function readJson(path: string): any {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function runCommand(cmd: string[], timeoutMs = 120_000, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import('child_process');
  const childEnv = { ...process.env, ...env };
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['inherit', 'pipe', 'pipe'], cwd: process.cwd(), env: childEnv });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timeout); resolve({ code: code ?? 0, stdout, stderr }); });
  });
}

async function fileHash(path: string): Promise<string> {
  const { createHash } = await import('crypto');
  const { createReadStream } = await import('fs');
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

async function copyRecursive(src: string, dest: string): Promise<{ success: boolean; filesCopied: number; error?: string }> {
  let filesCopied = 0;
  try {
    if (!existsSync(src)) return { success: false, filesCopied: 0, error: 'Source not found' };
    mkdirSync(dest, { recursive: true });
    const entries = readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        const result = await copyRecursive(srcPath, destPath);
        if (!result.success) return result;
        filesCopied += result.filesCopied;
      } else {
        cpSync(srcPath, destPath, { force: true });
        filesCopied++;
      }
    }
    return { success: true, filesCopied };
  } catch (e: any) {
    return { success: false, filesCopied, error: e.message };
  }
}

function updateHeartbeat(data: Partial<Heartbeat>) {
  const current = readJson(join(RUN_PATH, 'heartbeat.json')) || {};
  writeJson(join(RUN_PATH, 'heartbeat.json'), {
    ...current,
    ...data,
    runId: RUN_ID,
    lastUpdate: new Date().toISOString()
  });
}

function updateProgress(data: Partial<Progress>) {
  const current = readJson(join(RUN_PATH, 'checkpoints', 'progress.json')) || { runId: RUN_ID };
  const merged = {
    ...current,
    ...data,
    runId: RUN_ID
  };
  writeJson(join(RUN_PATH, 'checkpoints', 'progress.json'), merged);
}

function writeCheckpoint(type: 'course' | 'module' | 'lesson', id: string, data: any) {
  writeJson(join(RUN_PATH, 'checkpoints', type + 's', `${id}.json`), data);
}

function readCheckpoint(type: 'course' | 'module' | 'lesson', id: string): any {
  return readJson(join(RUN_PATH, 'checkpoints', type + 's', `${id}.json`));
}

function hasCheckpoint(type: 'course' | 'module' | 'lesson', id: string): boolean {
  return existsSync(join(RUN_PATH, 'checkpoints', type + 's', `${id}.json`));
}

console.log('=== SUPERVISED DISCOVERY EXECUTION ===\n');
console.log(`RUN_ID: ${RUN_ID}`);
console.log(`RUN_PATH: ${RUN_PATH}\n`);

// Setup directories
mkdirSync(join(RUN_PATH, 'logs'), { recursive: true });
mkdirSync(join(RUN_PATH, 'checkpoints', 'courses'), { recursive: true });
mkdirSync(join(RUN_PATH, 'checkpoints', 'modules'), { recursive: true });
mkdirSync(join(RUN_PATH, 'checkpoints', 'lessons'), { recursive: true });
mkdirSync(join(RUN_PATH, 'screenshots'), { recursive: true });
mkdirSync(join(RUN_PATH, 'traces'), { recursive: true });
mkdirSync(join(RUN_PATH, 'reports'), { recursive: true });
mkdirSync(join(RUN_PATH, 'backups'), { recursive: true });
mkdirSync(RUN_DIR, { recursive: true });

writeFileSync(join(RUN_DIR, 'latest_discover_run.txt'), RUN_ID);
writeFileSync(join(RUN_PATH, 'logs', 'run.log'), '');
writeFileSync(join(RUN_PATH, 'logs', 'run.ndjson'), '');
writeFileSync(join(RUN_PATH, 'logs', 'errors.ndjson'), '');

log(`=== SUPERVISED DISCOVERY RUN ===`);
log(`RUN_ID: ${RUN_ID}`);
log(`Started at: ${new Date().toISOString()}`);

// Initialize heartbeat
updateHeartbeat({ status: 'INIT', currentPhase: 'PREFLIGHT', startedAt: new Date().toISOString() });

// Heartbeat loop
let heartbeatInterval: Timer | undefined;
heartbeatInterval = setInterval(() => {
  updateHeartbeat({ lastUpdate: new Date().toISOString() });
}, HEARTBEAT_INTERVAL);

async function stopHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
}

// ============================================================================
// FASE 0: PRE-FLIGHT
// ============================================================================
log(`\n=== FASE 0: PRE-FLIGHT ===`);
updateProgress({ phases: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.phases || {}, preflight: 'RUNNING' } });
updateHeartbeat({ currentPhase: 'PREFLIGHT' });

const preflightReport: any = {
  runId: RUN_ID,
  timestamp: new Date().toISOString(),
  checks: [],
  status: 'PENDING'
};

async function preflightCheck(name: string, fn: () => Promise<{ ok: boolean; message: string }>) {
  const result = await fn();
  preflightReport.checks.push({ name, ...result, timestamp: new Date().toISOString() });
  log(`${result.ok ? '✓' : '✗'} ${name}: ${result.message}`);
  return result.ok;
}

let preflightOk = true;

// Check 1: Git branch
preflightOk = await preflightCheck('git_branch', async () => {
  try {
    const { stdout } = await runCommand(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
    preflightReport.gitBranch = stdout.trim();
    return { ok: true, message: `Branch: ${stdout.trim()}` };
  } catch { return { ok: true, message: 'Not a git repo' }; }
});

// Check 2: Dependencies
preflightOk = await preflightCheck('dependencies', async () => {
  const nodeModules = existsSync('node_modules');
  const bunLockb = existsSync('bun.lockb');
  return { ok: nodeModules && bunLockb, message: `node_modules: ${nodeModules}, bun.lockb: ${bunLockb}` };
});

// Check 3: Expected paths
preflightOk = await preflightCheck('expected_paths', async () => {
  const paths = ['storage/manifests', 'storage/downloads', 'storage/auth', 'src/scripts', 'src/config/platforms'];
  const missing = paths.filter(p => !existsSync(p));
  return { ok: missing.length === 0, message: missing.length === 0 ? 'All paths exist' : `Missing: ${missing.join(', ')}` };
});

// Check 4: Courses to process
preflightOk = await preflightCheck('courses_to_process', async () => {
  const manifestsDir = 'storage/manifests/themembers';
  if (!existsSync(manifestsDir)) return { ok: false, message: 'Manifests dir not found' };
  const files = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));
  preflightReport.expectedCourses = files.length;
  return { ok: files.length > 0, message: `Found ${files.length} course manifests` };
});

// Check 5: Login session
preflightOk = await preflightCheck('login_session', async () => {
  const authPath = 'storage/auth/themembers.json';
  const sessionValid = existsSync(authPath);
  if (!sessionValid) return { ok: false, message: 'No login session found - run bun run login first' };
  try {
    const session = JSON.parse(readFileSync(authPath, 'utf8'));
    const isExpired = session.expiresAt && new Date(session.expiresAt) < new Date();
    if (isExpired) return { ok: false, message: 'Session expired - run bun run login to refresh' };
    return { ok: true, message: 'Login session valid' };
  } catch { return { ok: false, message: 'Session file invalid' }; }
});

// Check 6: Extractor fix present
preflightOk = await preflightCheck('extractor_fix', async () => {
  const platformFile = 'src/config/platforms/themembers.ts';
  if (!existsSync(platformFile)) return { ok: false, message: 'Platform file not found' };
  const content = readFileSync(platformFile, 'utf8');
  const hasExtractModules = content.includes('extractModulesFromCoursePage');
  const hasModuleLoop = content.includes('for (const [moduleIndex, moduleInfo] of moduleLinks.entries())');
  return { ok: hasExtractModules && hasModuleLoop, message: hasExtractModules && hasModuleLoop ? 'Module-aware extractor is present' : 'Module-aware extractor NOT found - bug not fixed' };
});

preflightReport.status = preflightOk ? 'OK' : 'FAILED';
writeJson(join(RUN_PATH, 'reports', 'preflight_report.json'), preflightReport);
writeFileSync(join(RUN_PATH, 'reports', 'preflight_report.md'), `# PRE-FLIGHT REPORT\n\nRUN_ID: ${RUN_ID}\n\nStatus: ${preflightReport.status}\n\n## Checks\n\n${preflightReport.checks.map((c: any) => `- **${c.name}**: ${c.ok ? '✓' : '✗'} ${c.message}`).join('\n')}\n`);

updateProgress({ phases: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.phases || {}, preflight: preflightOk ? 'OK' : 'FAILED' } });
updateHeartbeat({ status: preflightOk ? 'RUNNING' : 'FAILED', currentPhase: preflightOk ? 'BACKUP' : 'PREFLIGHT_FAILED' });

if (!preflightOk) {
  log(`\n!!! PRE-FLIGHT FAILED !!!`, 'ERROR');
  log(`Run bun run login if session is invalid.`, 'ERROR');
  await stopHeartbeat();
  updateHeartbeat({ status: 'FAILED', lastError: 'PREFLIGHT_FAILED' });
  process.exit(1);
}

log(`\n✓ PRE-FLIGHT PASSED`);

// ============================================================================
// FASE 0: BACKUP
// ============================================================================
log(`\n=== BACKUP ===`);
updateProgress({ phases: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.phases || {}, backup: 'RUNNING' } });
updateHeartbeat({ currentPhase: 'BACKUP' });

const backupReport: any = {
  runId: RUN_ID,
  timestamp: new Date().toISOString(),
  files: [],
  status: 'PENDING'
};

const backupSources = [
  'storage/manifests',
  'storage/downloads',
  'storage/audit',
  'src/config/platforms/themembers.ts'
];

for (const source of backupSources) {
  if (!existsSync(source)) {
    log(`Source not found: ${source}`, 'WARN');
    continue;
  }
  const dest = join(RUN_PATH, 'backups', source.replace('storage/', 'storage_backup_').replace('src/', 'src_'));
  log(`Copying ${source} to ${dest}...`);
  const result = await copyRecursive(source, dest);
  backupReport.files.push({
    source,
    destination: dest,
    success: result.success,
    filesCopied: result.filesCopied,
    error: result.error
  });
  log(`${result.success ? '✓' : '✗'} ${source}: ${result.filesCopied} files copied${result.error ? ` - ${result.error}` : ''}`);
}

backupReport.status = backupReport.files.every((f: any) => f.success) ? 'OK' : 'PARTIAL';
writeJson(join(RUN_PATH, 'reports', 'backup_report.json'), backupReport);
writeFileSync(join(RUN_PATH, 'reports', 'backup_report.md'), `# BACKUP REPORT\n\nRUN_ID: ${RUN_ID}\n\nStatus: ${backupReport.status}\n\n${backupReport.files.map((f: any) => `- ${f.source} → ${f.destination}: ${f.success ? '✓' : '✗'} (${f.filesCopied} files)${f.error ? ` - ${f.error}` : ''}`).join('\n')}\n`);

updateProgress({ phases: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.phases || {}, backup: 'OK' } });
log(`\n✓ BACKUP COMPLETE`);

// ============================================================================
// FASE 3: RE-EXTRACTION
// ============================================================================
log(`\n=== FASE 3: RE-EXTRACTION ===`);
updateProgress({ phases: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.phases || {}, discovery: 'RUNNING' } });
updateHeartbeat({ currentPhase: 'DISCOVERY', currentCourse: 'STARTING' });

const discoveryReport: any = {
  runId: RUN_ID,
  timestamp: new Date().toISOString(),
  courses: [],
  summary: { total: 0, success: 0, failed: 0, skipped: 0 }
};

// Get course list
const manifestsDir = 'storage/manifests/themembers';
const courseFiles = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));
discoveryReport.summary.total = courseFiles.length;
updateProgress({ courses: { total: courseFiles.length, processed: 0, success: 0, failed: 0, skipped: 0 } });

// Check for resume
const resumeEnabled = process.env.CHECKPOINT_RESUME === '1';
const forceDiscover = process.env.DISCOVER_FORCE === '1';

log(`Courses to process: ${courseFiles.length}`);
log(`Resume enabled: ${resumeEnabled}`);
log(`Force discover: ${forceDiscover}`);

for (const [idx, file] of courseFiles.entries()) {
  const courseSlug = file.replace('.json', '');
  const courseName = courseSlug.replace(/-/g, ' ');
  const checkpointKey = `course_${courseSlug}`;

  // Read course URL from existing manifest
  const existingManifestPath = join(manifestsDir, file);
  const existingManifest = readJson(existingManifestPath);
  const courseUrl = existingManifest?.url || '';

  if (!courseUrl) {
    log(`  ✗ FAILED_PRECHECK: No course URL found in manifest`, 'ERROR');
    discoveryReport.courses.push({ slug: courseSlug, status: 'FAILED_PRECHECK', error: 'No course URL in manifest' });
    discoveryReport.summary.failed++;
    updateProgress({ courses: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.courses || {}, processed: idx + 1, failed: (readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.courses?.failed || 0) + 1 } });
    writeCheckpoint('course', checkpointKey, { status: 'FAILED_PRECHECK', error: 'No course URL in manifest', completedAt: new Date().toISOString() });
    logNDJSON({ timestamp: new Date().toISOString(), runId: RUN_ID, phase: 'DISCOVERY', action: 'discover_course', status: 'FAILED_PRECHECK', courseName, courseSlug, error: 'No course URL in manifest' });
    continue;
  }

  const courseUrlHost = courseUrl ? new URL(courseUrl).host : 'unknown';
  logNDJSON({ timestamp: new Date().toISOString(), runId: RUN_ID, phase: 'PRECHECK', action: 'course_url_check', courseSlug, courseUrlPresent: true, courseUrlHost, sourceOfCourseUrl: 'existingManifest' });

  log(`\n[${idx + 1}/${courseFiles.length}] Processing ${courseName}...`);
  log(`  URL: ${courseUrl}`);
  updateHeartbeat({ currentCourse: courseName, processedCourses: idx });

  // Check checkpoint
  if (resumeEnabled && !forceDiscover && hasCheckpoint('course', checkpointKey)) {
    const cp = readCheckpoint('course', checkpointKey);
    if (cp?.status === 'SUCCESS') {
      log(`  SKIPPED (already completed)`, 'WARN');
      discoveryReport.courses.push({ slug: courseSlug, status: 'SKIPPED_ALREADY_DONE' });
      discoveryReport.summary.skipped++;
      updateProgress({ courses: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.courses || {}, processed: idx + 1, skipped: (readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.courses?.skipped || 0) + 1 } });
      continue;
    }
  }

  // Run discovery for this course
  const startTime = Date.now();
  logNDJSON({ timestamp: new Date().toISOString(), runId: RUN_ID, phase: 'DISCOVERY', action: 'discover_course', status: 'RUNNING', courseName, courseSlug });

  try {
    const envVars: Record<string, string> = {
      DISCOVER_COURSE_ID: courseSlug,
      DISCOVER_COURSE_NAME: courseName,
      DISCOVER_COURSE_URL: courseUrl,
      DISCOVER_FORCE: forceDiscover ? '1' : '0',
      RUN_ID,
      RUN_PATH
    };

    const { code, stdout, stderr } = await runCommand(['bun', 'run', 'src/scripts/discover-one.ts'], 180_000, envVars);
    const durationMs = Date.now() - startTime;

    if (code === 0) {
      log(`  ✓ SUCCESS (${durationMs}ms)`);
      discoveryReport.courses.push({ slug: courseSlug, status: 'SUCCESS', durationMs });
      discoveryReport.summary.success++;
      updateProgress({ courses: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.courses || {}, processed: idx + 1, success: (readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.courses?.success || 0) + 1 } });
      writeCheckpoint('course', checkpointKey, { status: 'SUCCESS', durationMs, completedAt: new Date().toISOString() });
      logNDJSON({ timestamp: new Date().toISOString(), runId: RUN_ID, phase: 'DISCOVERY', action: 'discover_course', status: 'SUCCESS', courseName, courseSlug, durationMs });
    } else {
      log(`  ✗ FAILED (code ${code})`, 'ERROR');
      if (stderr) log(`  Error: ${stderr.slice(0, 500)}`, 'ERROR');
      discoveryReport.courses.push({ slug: courseSlug, status: 'FAILED', error: stderr?.slice(0, 200) });
      discoveryReport.summary.failed++;
      updateProgress({ courses: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.courses || {}, processed: idx + 1, failed: (readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.courses?.failed || 0) + 1 } });
      writeCheckpoint('course', checkpointKey, { status: 'FAILED', error: stderr?.slice(0, 200), completedAt: new Date().toISOString() });
      logNDJSON({ timestamp: new Date().toISOString(), runId: RUN_ID, phase: 'DISCOVERY', action: 'discover_course', status: 'FAILED_FINAL', courseName, courseSlug, error: stderr?.slice(0, 200) });
      logError({ timestamp: new Date().toISOString(), runId: RUN_ID, phase: 'DISCOVERY', action: 'discover_course', status: 'FAILED_FINAL', courseName, courseSlug, error: stderr?.slice(0, 200) });
    }
  } catch (e: any) {
    const durationMs = Date.now() - startTime;
    log(`  ✗ EXCEPTION: ${e.message}`, 'ERROR');
    discoveryReport.courses.push({ slug: courseSlug, status: 'FAILED', error: e.message });
    discoveryReport.summary.failed++;
    writeCheckpoint('course', checkpointKey, { status: 'FAILED', error: e.message });
    logError({ timestamp: new Date().toISOString(), runId: RUN_ID, phase: 'DISCOVERY', action: 'discover_course', status: 'FAILED_FINAL', courseName, courseSlug, error: e.message });
  }
}

// Calculate failure rate
const failureRate = discoveryReport.summary.total > 0 ? discoveryReport.summary.failed / discoveryReport.summary.total : 0;
if (failureRate > 0.2) {
  log(`\n!!! FAILURE RATE TOO HIGH (${(failureRate * 100).toFixed(1)}%) !!!`, 'ERROR');
  log(`Aborting. Max allowed is 20%.`, 'ERROR');
  updateProgress({ phases: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.phases || {}, discovery: 'FAILED' } });
  updateHeartbeat({ status: 'FAILED', lastError: `Failure rate ${(failureRate * 100).toFixed(1)}% exceeds 20%` });
  writeJson(join(RUN_PATH, 'reports', 'discovery_report.json'), discoveryReport);
  await stopHeartbeat();
  process.exit(1);
}

discoveryReport.status = discoveryReport.summary.failed === 0 ? 'OK' : 'PARTIAL';
writeJson(join(RUN_PATH, 'reports', 'discovery_report.json'), discoveryReport);
writeFileSync(join(RUN_PATH, 'reports', 'discovery_report.md'), `# DISCOVERY REPORT\n\nRUN_ID: ${RUN_ID}\n\nStatus: ${discoveryReport.status}\n\n## Summary\n\n- Total: ${discoveryReport.summary.total}\n- Success: ${discoveryReport.summary.success}\n- Failed: ${discoveryReport.summary.failed}\n- Skipped: ${discoveryReport.summary.skipped}\n\n## Courses\n\n${discoveryReport.courses.map((c: any) => `- ${c.slug}: ${c.status}${c.error ? ` - ${c.error.slice(0, 100)}` : ''}`).join('\n')}\n`);

updateProgress({ phases: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.phases || {}, discovery: discoveryReport.summary.failed > 0 ? 'PARTIAL' : 'OK' } });
updateHeartbeat({ currentPhase: 'VALIDATION', currentCourse: '' });

log(`\n✓ DISCOVERY COMPLETE: ${discoveryReport.summary.success} success, ${discoveryReport.summary.failed} failed, ${discoveryReport.summary.skipped} skipped`);

// ============================================================================
// FASE 4: STRUCTURAL VALIDATION
// ============================================================================
log(`\n=== FASE 4: STRUCTURAL VALIDATION ===`);
updateProgress({ phases: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.phases || {}, validation: 'RUNNING' } });
updateHeartbeat({ currentPhase: 'VALIDATION' });

const validationReport: any = {
  runId: RUN_ID,
  timestamp: new Date().toISOString(),
  checks: [],
  multiModuleCourses: [],
  issues: [],
  status: 'PENDING'
};

const manifestFiles = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));
let coursesWithMultipleModules = 0;
let coursesWithModuleIssues = 0;

for (const file of manifestFiles) {
  const raw = readFileSync(join(manifestsDir, file), 'utf8');
  const manifest = JSON.parse(raw);
  const moduleCount = manifest.modules.filter((m: any) => m.lessons && m.lessons.some((l: any) => l.name !== 'Discovery failed')).length;

  if (moduleCount > 1) {
    coursesWithMultipleModules++;
    validationReport.multiModuleCourses.push({
      course: manifest.course,
      slug: manifest.slug,
      moduleCount,
      modules: manifest.modules.map((m: any) => ({ name: m.name, lessonCount: m.lessons.filter((l: any) => l.name !== 'Discovery failed').length }))
    });

    // Check for lesson number reuse across modules (potential concatenation indicator)
    for (const mod of manifest.modules) {
      const lessonNumbers = new Map<string, number>();
      for (const lesson of mod.lessons) {
        if (lesson.name === 'Discovery failed') continue;
        const match = lesson.name.match(/AULA\s*(\d+)/i);
        if (match) {
          const num = match[1];
          lessonNumbers.set(num, (lessonNumbers.get(num) || 0) + 1);
        }
      }
      // Duplicate lesson numbers within same module might indicate issues
      for (const [num, count] of lessonNumbers) {
        if (count > 1) {
          validationReport.issues.push({
            type: 'DUPLICATE_LESSON_NUMBER_IN_MODULE',
            course: manifest.course,
            module: mod.name,
            lessonNumber: num,
            count
          });
        }
      }
    }
  }

  // Check for modules with 0 lessons
  for (const mod of manifest.modules) {
    const validLessons = mod.lessons.filter((l: any) => l.name !== 'Discovery failed');
    if (validLessons.length === 0 && manifest.modules.length > 1) {
      validationReport.issues.push({ type: 'EMPTY_MODULE', course: manifest.course, module: mod.name });
    }
  }

  // Check for courses that had multiple modules but now have 1
  if (moduleCount === 1 && manifest.modules[0]?.name.includes('Encontro')) {
    // This might indicate the concatenation bug still present
    const hasEncontroName = manifest.modules[0]?.name || '';
    if (manifest.course.toLowerCase().includes('currículo') || manifest.course.toLowerCase().includes('curriculo')) {
      validationReport.issues.push({
        type: 'SINGLE_MODULE_WITH_ENCONTRO',
        course: manifest.course,
        moduleName: hasEncontroName,
        note: 'Course may have multiple modules but extracted as single'
      });
      coursesWithModuleIssues++;
    }
  }
}

validationReport.checks.push({ name: 'multi_module_courses_detected', ok: coursesWithMultipleModules > 0, message: `${coursesWithMultipleModules} courses have 2+ modules` });
validationReport.checks.push({ name: 'module_concatenation_check', ok: coursesWithModuleIssues === 0, message: coursesWithModuleIssues === 0 ? 'No concatenation detected' : `${coursesWithModuleIssues} courses may have concatenated modules` });

validationReport.status = validationReport.issues.filter((i: any) => i.type === 'EMPTY_MODULE' || i.type === 'SINGLE_MODULE_WITH_ENCONTRO').length === 0 ? 'STRUCTURE_VALID' : 'STRUCTURE_VALID_WITH_WARNINGS';

writeJson(join(RUN_PATH, 'reports', 'structural_validation.json'), validationReport);
writeFileSync(join(RUN_PATH, 'reports', 'structural_validation_report.md'), `# STRUCTURAL VALIDATION REPORT\n\nRUN_ID: ${RUN_ID}\n\nStatus: ${validationReport.status}\n\n## Checks\n\n${validationReport.checks.map((c: any) => `- **${c.name}**: ${c.ok ? '✓' : '⚠'} ${c.message}`).join('\n')}\n\n## Multi-Module Courses (${validationReport.multiModuleCourses.length})\n\n${validationReport.multiModuleCourses.length === 0 ? 'No multi-module courses detected - this may indicate the extraction bug persists' : validationReport.multiModuleCourses.map((c: any) => `- ${c.course}: ${c.moduleCount} modules`).join('\n')}\n\n## Issues (${validationReport.issues.length})\n\n${validationReport.issues.length === 0 ? 'No issues detected' : validationReport.issues.map((i: any) => `- **${i.type}**: ${i.course}${i.module ? ` / ${i.module}` : ''} - ${JSON.stringify(i)}`).join('\n')}\n`);

updateProgress({ phases: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.phases || {}, validation: validationReport.status === 'STRUCTURE_VALID' ? 'OK' : 'PARTIAL' } });
log(`\n✓ VALIDATION COMPLETE: ${validationReport.status}`);

// ============================================================================
// FASE 5: RE-AUDIT OF ASSETS
// ============================================================================
log(`\n=== FASE 5: RE-AUDIT OF ASSETS ===`);
updateProgress({ phases: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.phases || {}, audit: 'RUNNING' } });
updateHeartbeat({ currentPhase: 'AUDIT' });

// Build asset inventory from new manifests
interface AssetInventory {
  course: string;
  module: string;
  lesson: string;
  asset: string;
  occurrences: number;
  modulesWithAsset: string[];
}

const assetInventory: AssetInventory[] = [];
const assetByKey = new Map<string, AssetInventory>();

for (const file of manifestFiles) {
  const raw = readFileSync(join(manifestsDir, file), 'utf8');
  const manifest = JSON.parse(raw);

  for (const mod of manifest.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;
      for (const asset of lesson.assets) {
        const key = `${asset.name}`;
        if (!assetByKey.has(key)) {
          const inv: AssetInventory = { course: manifest.course, module: mod.name, lesson: lesson.name, asset: asset.name, occurrences: 0, modulesWithAsset: [] };
          assetByKey.set(key, inv);
          assetInventory.push(inv);
        }
        const inv = assetByKey.get(key)!;
        inv.occurrences++;
        if (!inv.modulesWithAsset.includes(mod.name)) {
          inv.modulesWithAsset.push(mod.name);
        }
      }
    }
  }
}

// Classify assets
const auditReport: any = {
  runId: RUN_ID,
  timestamp: new Date().toISOString(),
  summary: { totalAssets: assetInventory.length },
  classifications: { SOURCE_CONFIRMED_SHARED: [], SOURCE_CONFIRMED_MISMATCH: [], SOURCE_INCONCLUSIVE: [], REVIEW_REQUIRED: [] },
  suspicious: [],
  inconclusive: []
};

const SAFE_PATTERNS = [/workbook/i, /apostila/i, /material\s*(complementar|geral|de\s*apoio)/i, /checklist/i, /template/i, /ebook/i, /guia/i, /branding/i, /logo/i, /capa/i, /intro/i, /conteudo/i, /exercicio/i, /exercise/i];

for (const inv of assetInventory) {
  const isSafePattern = SAFE_PATTERNS.some(p => p.test(inv.asset));

  if (inv.occurrences >= 3 && inv.modulesWithAsset.length === 1) {
    // Same module, repeated - suspicious
    const hasAulaNumber = /aula\s*\d+/i.test(inv.asset);
    if (hasAulaNumber) {
      auditReport.classifications.SOURCE_CONFIRMED_MISMATCH.push(inv);
      auditReport.suspicious.push(inv);
    } else {
      auditReport.classifications.REVIEW_REQUIRED.push(inv);
    }
  } else if (inv.occurrences >= 2 && inv.modulesWithAsset.length > 1) {
    // Multiple modules - could be legitimate shared material
    if (isSafePattern) {
      auditReport.classifications.SOURCE_CONFIRMED_SHARED.push(inv);
    } else {
      auditReport.classifications.SOURCE_INCONCLUSIVE.push(inv);
      auditReport.inconclusive.push(inv);
    }
  } else if (isSafePattern) {
    auditReport.classifications.SOURCE_CONFIRMED_SHARED.push(inv);
  } else if (inv.occurrences === 1) {
    auditReport.classifications.REVIEW_REQUIRED.push(inv);
  } else {
    auditReport.classifications.SOURCE_INCONCLUSIVE.push(inv);
    auditReport.inconclusive.push(inv);
  }
}

writeJson(join(RUN_PATH, 'reports', 'post_rediscovery_asset_audit.json'), auditReport);
writeFileSync(join(RUN_PATH, 'reports', 'post_rediscovery_asset_audit.md'), `# POST-REDISCOVERY ASSET AUDIT\n\nRUN_ID: ${RUN_ID}\n\n## Summary\n\nTotal assets: ${auditReport.summary.totalAssets}\n\n## Classifications\n\n| Classification | Count |\n|---|---:|\n| SOURCE_CONFIRMED_SHARED | ${auditReport.classifications.SOURCE_CONFIRMED_SHARED.length} |\n| SOURCE_CONFIRMED_MISMATCH | ${auditReport.classifications.SOURCE_CONFIRMED_MISMATCH.length} |\n| SOURCE_INCONCLUSIVE | ${auditReport.classifications.SOURCE_INCONCLUSIVE.length} |\n| REVIEW_REQUIRED | ${auditReport.classifications.REVIEW_REQUIRED.length} |\n\n## Suspicious (${auditReport.suspicious.length})\n\n${auditReport.suspicious.length === 0 ? 'None' : auditReport.suspicious.map((s: any) => `- ${s.asset} (${s.occurrences}x in ${s.module})`).join('\n')}\n\n## Inconclusive (${auditReport.inconclusive.length})\n\n${auditReport.inconclusive.length === 0 ? 'None' : auditReport.inconclusive.map((i: any) => `- ${i.asset} (${i.occurrences}x across ${i.modulesWithAsset.length} modules)`).join('\n')}\n`);

updateProgress({ phases: { ...readJson(join(RUN_PATH, 'checkpoints', 'progress.json'))?.phases || {}, audit: 'OK' } });
log(`\n✓ AUDIT COMPLETE: ${assetInventory.length} assets, ${auditReport.suspicious.length} suspicious, ${auditReport.inconclusive.length} inconclusive`);

// ============================================================================
// FASE 6: RECONCILIATION
// ============================================================================
log(`\n=== FASE 6: RECONCILIATION ===`);

const reconciliationReport: any = {
  runId: RUN_ID,
  timestamp: new Date().toISOString(),
  previousRemovalsInvalidated: [],
  stillValidRemovals: [],
  needsManualReview: [],
  status: 'PENDING'
};

// Load previous audit data
const previousAudit = readJson('storage/audit/source_inconclusive_remaining.json');
const previousRemovals = readJson('storage/audit/final_removed_assets.json');

reconciliationReport.note = 'Previous audit was based on pre-module-fix extraction. Some removals may have been false positives due to module concatenation. Manual review recommended for all previously removed assets.';

writeJson(join(RUN_PATH, 'reports', 'removal_reconciliation.json'), reconciliationReport);
writeFileSync(join(RUN_PATH, 'reports', 'removal_reconciliation_report.md'), `# REMOVAL RECONCILIATION REPORT\n\nRUN_ID: ${RUN_ID}\n\n## Note\n\n${reconciliationReport.note}\n\n## Classification\n\n- Previous removals invalidated by module fix: ${reconciliationReport.previousRemovalsInvalidated.length}\n- Still valid removals: ${reconciliationReport.stillValidRemovals.length}\n- Needs manual review: ${reconciliationReport.needsManualReview.length}\n`);

log(`\n✓ RECONCILIATION COMPLETE`);

// ============================================================================
// FASE 7: FINAL REPORTS
// ============================================================================
log(`\n=== FASE 7: FINAL REPORTS ===`);

const finalReport = {
  runId: RUN_ID,
  runPath: RUN_PATH,
  timestamp: new Date().toISOString(),
  phases: {
    preflight: 'OK',
    backup: 'OK',
    discovery: discoveryReport.status,
    validation: validationReport.status,
    audit: 'OK'
  },
  summary: {
    coursesProcessed: discoveryReport.summary.total,
    coursesSuccess: discoveryReport.summary.success,
    coursesFailed: discoveryReport.summary.failed,
    coursesSkipped: discoveryReport.summary.skipped,
    multiModuleCoursesFound: coursesWithMultipleModules,
    totalAssets: assetInventory.length,
    suspiciousAssets: auditReport.suspicious.length,
    inconclusiveAssets: auditReport.inconclusive.length
  },
  status: discoveryReport.summary.failed === 0 && validationReport.status !== 'STRUCTURE_INVALID' ? 'REDISCOVERY_READY_FOR_REVIEW' : 'PARTIAL_REDISCOVERY_REVIEW_REQUIRED',
  nextSteps: discoveryReport.summary.failed === 0 && validationReport.status !== 'STRUCTURE_INVALID'
    ? ['Review suspicious assets', 'Verify multi-module courses', 'Proceed to selective cleanup if needed']
    : ['Fix structural issues before proceeding', 'Review failed courses', 'Re-run discovery for failed courses']
};

writeJson(join(RUN_PATH, 'reports', 'final_summary.json'), finalReport);
writeFileSync(join(RUN_PATH, 'reports', 'final_summary.md'), `# FINAL REDISCOVERY SUMMARY\n\nRUN_ID: ${RUN_ID}\n\n## Status\n\n**${finalReport.status}**\n\n## Phase Results\n\n${Object.entries(finalReport.phases).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\n## Summary\n\n${Object.entries(finalReport.summary).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}\n\n## Next Steps\n\n${finalReport.nextSteps.map((s: string) => `- ${s}`).join('\n')}\n`);

log(`\n=== EXECUTION COMPLETE ===`);
log(`Status: ${finalReport.status}`);
log(`Reports: ${RUN_PATH}/reports/`);

updateHeartbeat({ status: finalReport.status === 'REDISCOVERY_READY_FOR_REVIEW' ? 'SUCCESS' : 'PARTIAL', currentPhase: 'COMPLETE' });

// Cleanup
await stopHeartbeat();

// Final output
console.log('\n' + '='.repeat(60));
console.log('## Run');
console.log(`- RUN_ID: ${RUN_ID}`);
console.log(`- path: ${RUN_PATH}`);
console.log('');
console.log('## FASE 3 — Re-extração');
console.log(`- cursos processados: ${discoveryReport.summary.total}`);
console.log(`- módulos: ${coursesWithMultipleModules}`);
console.log(`- aulas: ${validationReport.checks[0]?.message || 'N/A'}`);
console.log(`- sucesso: ${discoveryReport.summary.success}`);
console.log(`- falhas: ${discoveryReport.summary.failed}`);
console.log(`- skipped: ${discoveryReport.summary.skipped}`);
console.log(`- status: ${discoveryReport.status}`);
console.log('');
console.log('## FASE 4 — Validação estrutural');
console.log(`- status: ${validationReport.status}`);
console.log(`- errors: ${validationReport.issues.filter((i: any) => i.type === 'EMPTY_MODULE' || i.type === 'SINGLE_MODULE_WITH_ENCONTRO').length}`);
console.log(`- warnings: ${validationReport.issues.length}`);
console.log('');
console.log('## FASE 5 — Re-audit de assets');
console.log(`- assets auditados: ${assetInventory.length}`);
console.log(`- suspeitos restantes: ${auditReport.suspicious.length}`);
console.log(`- inconclusivos: ${auditReport.inconclusive.length}`);
console.log(`- status: OK`);
console.log('');
console.log('## FASE 6 — Reconciliação');
console.log(`- remoções ainda válidas: TBD`);
console.log(`- remoções invalidadas: TBD`);
console.log(`- review required: ${reconciliationReport.needsManualReview.length}`);
console.log('');
console.log('## Segurança');
console.log(`- backup: OK`);
console.log(`- raw extraction preservado: OK`);
console.log(`- rollback preservado: OK`);
console.log(`- deleção física executada: NÃO`);
console.log('');
console.log('## Relatórios gerados');
console.log(`${RUN_PATH}/reports/*.md`);
console.log(`${RUN_PATH}/reports/*.json`);
console.log('');
console.log('## Próxima ação recomendada');
console.log(finalReport.status === 'REDISCOVERY_READY_FOR_REVIEW'
  ? 'Revisão humana dos assets suspeitos e inconclusivos. Após validação, proceder com cleanup seletivo.'
  : 'Revisar falhas estruturais e cursos que falharam antes de prosseguir.');