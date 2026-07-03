import fs from 'fs-extra';
import path from 'node:path';
import { ManifestStore } from '../core/manifest/store';
import type { Asset, CourseManifest, LessonManifest, ModuleManifest } from '../core/types';
import { runtimeContext, manifestStore } from './common';

const context = runtimeContext(true);
const store = manifestStore(context);

interface LessonRef {
  course: string;
  module: string;
  lesson: string;
  lessonIndex: number;
  moduleIndex: number;
}

interface AuditFinding {
  type: 'leaked-asset' | 'unresolved-elsewhere-resolved' | 'suspicious-count' | 'empty-lesson-with-siblings' | 'duplicate-url-across-lessons';
  severity: 'high' | 'medium' | 'low';
  message: string;
  details: Record<string, unknown>;
}

async function auditCourse(manifest: CourseManifest): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const assetMap = new Map<string, Array<{ asset: Asset; ref: LessonRef }>>();
  const urlMap = new Map<string, Array<LessonRef>>();

  for (const [moduleIndex, mod] of manifest.modules.entries()) {
    for (const [lessonIndex, lesson] of mod.lessons.entries()) {
      const ref: LessonRef = {
        course: manifest.course,
        module: mod.name,
        lesson: lesson.name,
        lessonIndex,
        moduleIndex
      };

      // Track assets by normalized name
      for (const asset of lesson.assets) {
        const normalizedName = asset.name.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!assetMap.has(normalizedName)) assetMap.set(normalizedName, []);
        assetMap.get(normalizedName)!.push({ asset, ref });

        // Track resolved URLs
        if (!asset.url.startsWith('unresolved://')) {
          if (!urlMap.has(asset.url)) urlMap.set(asset.url, []);
          urlMap.get(asset.url)!.push(ref);
        }
      }

      // Suspicious asset count
      const assetCount = lesson.assets.filter((a) => !a.url.startsWith('unresolved://') || a.status !== 'failed').length;
      if (assetCount > 15) {
        findings.push({
          type: 'suspicious-count',
          severity: 'medium',
          message: `Lesson has unusually high asset count (${assetCount})`,
          details: { ...ref, assetCount }
        });
      }
    }

    // Empty lesson with siblings having assets
    const lessonsWithAssets = mod.lessons.filter(
      (l) => l.assets.some((a) => !a.url.startsWith('unresolved://') && a.status !== 'failed')
    );
    if (lessonsWithAssets.length > 0) {
      for (const lesson of mod.lessons) {
        const hasAssets = lesson.assets.some((a) => !a.url.startsWith('unresolved://') && a.status !== 'failed');
        if (!hasAssets && lesson.assets.length > 0) {
          findings.push({
            type: 'empty-lesson-with-siblings',
            severity: 'low',
            message: `Lesson has no resolvable assets but siblings do`,
            details: {
              course: manifest.course,
              module: mod.name,
              lesson: lesson.name,
              unresolvedCount: lesson.assets.filter((a) => a.url.startsWith('unresolved://')).length
            }
          });
        }
      }
    }
  }

  // Detect leaked assets: same name in multiple lessons
  for (const [name, occurrences] of assetMap) {
    const uniqueLessons = new Set(occurrences.map((o) => `${o.ref.moduleIndex}-${o.ref.lessonIndex}`));
    if (uniqueLessons.size > 1) {
      // Check if it's truly a leak or a legitimate global material
      const lessonNames = occurrences.map((o) => o.ref.lesson);
      const firstLesson = lessonNames[0];
      const allSameLesson = lessonNames.every((n) => n === firstLesson);
      if (allSameLesson) continue; // Same lesson name in different modules — possible but unlikely

      // High confidence leak: same resolved URL in different lessons
      const resolvedOccurrences = occurrences.filter((o) => !o.asset.url.startsWith('unresolved://'));
      const uniqueUrls = new Set(resolvedOccurrences.map((o) => o.asset.url));
      if (uniqueUrls.size === 1 && resolvedOccurrences.length > 1) {
        findings.push({
          type: 'leaked-asset',
          severity: 'high',
          message: `Asset "${name}" appears in ${uniqueLessons.size} different lessons with same URL — likely leaked from sidebar/global`,
          details: {
            assetName: name,
            lessonCount: uniqueLessons.size,
            url: resolvedOccurrences[0]?.asset.url ?? 'unknown',
            occurrences: resolvedOccurrences.map((o) => ({
              module: o.ref.module,
              lesson: o.ref.lesson
            }))
          }
        });
      } else if (uniqueLessons.size > 2) {
        findings.push({
          type: 'leaked-asset',
          severity: 'medium',
          message: `Asset "${name}" appears in ${uniqueLessons.size} different lessons — possible leak`,
          details: {
            assetName: name,
            lessonCount: uniqueLessons.size,
            occurrences: occurrences.map((o) => ({
              module: o.ref.module,
              lesson: o.ref.lesson,
              url: o.asset.url
            }))
          }
        });
      }
    }
  }

  // Detect unresolved assets that are resolved elsewhere
  for (const [name, occurrences] of assetMap) {
    const unresolved = occurrences.filter((o) => o.asset.url.startsWith('unresolved://'));
    const resolved = occurrences.filter((o) => !o.asset.url.startsWith('unresolved://'));
    if (unresolved.length > 0 && resolved.length > 0) {
      findings.push({
        type: 'unresolved-elsewhere-resolved',
        severity: 'medium',
        message: `Asset "${name}" is unresolved in some lessons but resolved in others — extraction may be inconsistent`,
        details: {
          assetName: name,
          unresolvedIn: unresolved.map((o) => ({ module: o.ref.module, lesson: o.ref.lesson })),
          resolvedIn: resolved.map((o) => ({ module: o.ref.module, lesson: o.ref.lesson, url: o.asset.url }))
        }
      });
    }
  }

  // Detect duplicate URLs across lessons (same file in many lessons)
  for (const [url, refs] of urlMap) {
    const uniqueLessons = new Set(refs.map((r) => `${r.moduleIndex}-${r.lessonIndex}`));
    if (uniqueLessons.size > 3) {
      findings.push({
        type: 'duplicate-url-across-lessons',
        severity: 'medium',
        message: `Same URL appears in ${uniqueLessons.size} different lessons — possible global material or leak`,
        details: {
          url,
          lessonCount: uniqueLessons.size,
          lessons: refs.map((r) => ({ module: r.module, lesson: r.lesson }))
        }
      });
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const platform = process.env.AUDIT_PLATFORM ?? 'themembers';
  const manifests = await store.listCourseManifests(platform);

  if (manifests.length === 0) {
    console.error(`No manifests found for platform ${platform}`);
    process.exit(1);
  }

  let totalFindings = 0;
  const reportLines: string[] = [];
  reportLines.push(`# Audit Report — ${platform}`);
  reportLines.push(`Generated: ${new Date().toISOString()}`);
  reportLines.push(`Manifests analyzed: ${manifests.length}`);
  reportLines.push('');

  for (const manifestPath of manifests) {
    let manifest: CourseManifest;
    try {
      manifest = await store.readCourse(manifestPath);
    } catch {
      console.error(`Failed to read manifest: ${manifestPath}`);
      continue;
    }

    const findings = await auditCourse(manifest);
    totalFindings += findings.length;

    const lessonCount = manifest.modules.reduce((sum, m) => sum + m.lessons.length, 0);
    const assetCount = manifest.modules.reduce(
      (sum, m) => sum + m.lessons.reduce((lSum, l) => lSum + l.assets.length, 0),
      0
    );

    reportLines.push(`## ${manifest.course}`);
    reportLines.push(`- Modules: ${manifest.modules.length}`);
    reportLines.push(`- Lessons: ${lessonCount}`);
    reportLines.push(`- Total assets: ${assetCount}`);
    reportLines.push(`- Findings: ${findings.length}`);
    reportLines.push('');

    if (findings.length === 0) {
      reportLines.push('_No issues detected._');
      reportLines.push('');
      continue;
    }

    const bySeverity = { high: findings.filter((f) => f.severity === 'high'), medium: findings.filter((f) => f.severity === 'medium'), low: findings.filter((f) => f.severity === 'low') };

    for (const severity of ['high', 'medium', 'low'] as const) {
      const items = bySeverity[severity];
      if (items.length === 0) continue;
      reportLines.push(`### ${severity.toUpperCase()} (${items.length})`);
      for (const finding of items) {
        reportLines.push(`- **${finding.type}**: ${finding.message}`);
        if (finding.details.occurrences) {
          const occurrences = finding.details.occurrences as Array<{ module: string; lesson: string; url?: string }>;
          for (const occ of occurrences.slice(0, 5)) {
            reportLines.push(`  - ${occ.module} / ${occ.lesson}${occ.url ? ` → ${occ.url}` : ''}`);
          }
          if (occurrences.length > 5) {
            reportLines.push(`  - ... and ${occurrences.length - 5} more`);
          }
        }
        if (finding.details.unresolvedIn) {
          const unresolved = finding.details.unresolvedIn as Array<{ module: string; lesson: string }>;
          reportLines.push(`  - Unresolved in: ${unresolved.map((u) => `${u.module}/${u.lesson}`).join(', ')}`);
        }
        if (finding.details.resolvedIn) {
          const resolved = finding.details.resolvedIn as Array<{ module: string; lesson: string; url: string }>;
          reportLines.push(`  - Resolved in: ${resolved.map((r) => `${r.module}/${r.lesson}`).join(', ')}`);
        }
      }
      reportLines.push('');
    }
  }

  reportLines.push('---');
  reportLines.push(`**Total findings across all courses: ${totalFindings}**`);

  const reportPath = path.join(context.logsDir, `audit-report-${platform}-${Date.now()}.md`);
  await fs.ensureDir(context.logsDir);
  await fs.writeFile(reportPath, reportLines.join('\n'));

  console.log(`Audit complete: ${totalFindings} findings across ${manifests.length} courses`);
  console.log(`Report: ${reportPath}`);

  if (totalFindings > 0) {
    process.exit(2); // Non-zero exit to signal findings in CI
  }
}

await main();
