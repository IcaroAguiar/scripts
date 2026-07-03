import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';

interface Classification {
  assetName: string;
  course: string;
  lessonName: string;
  classification: string;
  confidence: string;
  reason: string;
  evidence: string;
  action: string;
}

interface SubagentVotes {
  remove: string[];
  keep: string[];
  review: string[];
}

interface ConsensusDecision {
  assetName: string;
  course: string;
  lessons: string[];
  votes: string[];
  consensusReached: boolean;
  confidence: string;
  decision: string;
  reason: string;
}

// Load phase2 classification
const phase2 = JSON.parse(readFileSync('storage/audit/phase2-classification.json', 'utf8'));
const classifications: Classification[] = phase2.classifications;

// Group by normalized asset name + course
const assetKeyMap = new Map<string, Classification[]>();
for (const c of classifications) {
  const key = `${c.course}|${c.assetName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')}`;
  if (!assetKeyMap.has(key)) assetKeyMap.set(key, []);
  assetKeyMap.get(key)!.push(c);
}

console.log('=== FASE 4: CONSENSUS DECISIONS ===\n');

// Track decisions
const consensusDecisions: ConsensusDecision[] = [];
let removeCount = 0, reviewCount = 0, keepCount = 0;

for (const [key, entries] of assetKeyMap) {
  if (entries.length === 0) continue;

  // Aggregate votes
  const votes: SubagentVotes = { remove: [], keep: [], review: [] };

  for (const entry of entries) {
    const lesson = entry.lessonName;
    switch (entry.action) {
      case 'REMOVE':
        votes.remove.push(lesson);
        break;
      case 'KEEP':
        votes.keep.push(lesson);
        break;
      case 'REVIEW':
        votes.review.push(lesson);
        break;
    }
  }

  // Determine consensus
  // REMOVE consensus: 2+ subagents agree AND HIGH confidence OR systematic leak pattern
  // KEEP consensus: majority is KEEP and no strong evidence for removal
  // REVIEW: everything else

  const firstEntry = entries[0];
  const course = firstEntry.course;
  const assetName = firstEntry.assetName;
  const allLessons = entries.map(e => e.lessonName);

  let decision = 'REVIEW';
  let reason = '';
  let consensusReached = false;
  let confidence = 'MEDIUM';

  // Check for systematic leak pattern (same asset, consistent offset, >3 lessons)
  const occurrences = entries.length;
  const offsets = entries.map((e: any) => e.offset).filter((o: any) => o !== 0);
  const uniqueOffsets = new Set(offsets);
  const hasConsistentOffset = uniqueOffsets.size === 1 && offsets.length > 2;
  const hasSystematicLeak = occurrences > 5 || hasConsistentOffset;

  // Check for "Aula XX" mismatch
  const aulaMatch = assetName.match(/Aula\s*(\d+)/i);
  const aulaNum = aulaMatch ? parseInt(aulaMatch[1]) : null;
  const lessonNums = entries.map((e: any) => {
    const m = e.lessonName.match(/Aula\s*(\d+)/i);
    return m ? parseInt(m[1]) : -1;
  }).filter((n: number) => n > 0);
  const allFarAway = aulaNum && lessonNums.length > 0 && lessonNums.every((ln: number) => Math.abs(aulaNum - ln) > 2);

  // Check for hash/artifact
  const isHashArtifact = /^[a-z0-9]{20,}$/i.test(assetName.replace(/\s/g, ''));

  // Check for duplicate attachment (same asset appearing twice in same lesson)
  const lessonCounts = new Map<string, number>();
  for (const e of entries) {
    lessonCounts.set(e.lessonName, (lessonCounts.get(e.lessonName) || 0) + 1);
  }
  const hasDuplicateAttachment = [...lessonCounts.values()].some(c => c > 1);

  if (isHashArtifact) {
    decision = 'REMOVE';
    reason = 'Platform hash artifact - no student content value';
    consensusReached = true;
    confidence = 'HIGH';
  } else if (allFarAway && aulaNum) {
    decision = 'REMOVE';
    reason = `Asset claims "Aula ${aulaNum}" but all ${occurrences} appearances are >2 lessons away`;
    consensusReached = true;
    confidence = 'HIGH';
  } else if (hasSystematicLeak && votes.remove.length >= 1) {
    decision = 'REMOVE';
    reason = `Systematic platform leak: ${occurrences} appearances with consistent pattern`;
    consensusReached = true;
    confidence = 'HIGH';
  } else if (hasDuplicateAttachment && votes.remove.length >= 1) {
    decision = 'REMOVE';
    reason = `Duplicate attachment bug: same asset attached ${[...lessonCounts.values()].filter(c => c > 1).join(',')}x per lesson`;
    consensusReached = true;
    confidence = 'HIGH';
  } else if (votes.remove.length >= 2) {
    decision = 'REMOVE';
    reason = `${votes.remove.length} lessons vote REMOVE, consensus reached`;
    consensusReached = true;
    confidence = 'HIGH';
  } else if (votes.remove.length === 1 && votes.keep.length >= votes.remove.length) {
    decision = 'REVIEW';
    reason = 'Conflicting votes - conservative gate triggered';
    consensusReached = false;
  } else if (votes.keep.length > votes.remove.length && votes.remove.length === 0) {
    decision = 'KEEP';
    reason = 'Majority votes KEEP, no removal evidence';
    consensusReached = true;
    confidence = 'LOW';
  } else {
    decision = 'REVIEW';
    reason = 'No consensus reached - requires human judgment';
    consensusReached = false;
  }

  consensusDecisions.push({
    assetName,
    course,
    lessons: allLessons,
    votes: [
      ...votes.remove.map(l => `REMOVE:${l}`),
      ...votes.keep.map(l => `KEEP:${l}`),
      ...votes.review.map(l => `REVIEW:${l}`)
    ],
    consensusReached,
    confidence,
    decision,
    reason
  });

  // Count
  if (decision === 'REMOVE') removeCount++;
  else if (decision === 'KEEP') keepCount++;
  else reviewCount++;

  // Print summary for removal decisions
  if (decision === 'REMOVE') {
    console.log(`REMOVE: ${assetName} (${course})`);
    console.log(`  Reason: ${reason}`);
    console.log(`  Lessons: ${allLessons.join(', ')}`);
    console.log('');
  }
}

console.log(`\n=== CONSENSUS SUMMARY ===`);
console.log(`REMOVE: ${removeCount}`);
console.log(`KEEP: ${keepCount}`);
console.log(`REVIEW: ${reviewCount}`);

// Sort by decision priority (REMOVE first)
consensusDecisions.sort((a, b) => {
  if (a.decision !== b.decision) {
    const order = { REMOVE: 0, KEEP: 1, REVIEW: 2 };
    return order[a.decision as keyof typeof order] - order[b.decision as keyof typeof order];
  }
  return b.confidence.localeCompare(a.confidence);
});

// Save consensus decisions
writeFileSync(
  'storage/audit/phase4-consensus.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    summary: { remove: removeCount, keep: keepCount, review: reviewCount },
    decisions: consensusDecisions
  }, null, 2)
);

console.log('\nSaved to storage/audit/phase4-consensus.json');

// Generate removal list for Phase 5
const removalList = consensusDecisions.filter(d => d.decision === 'REMOVE');
console.log(`\nAssets approved for removal: ${removalList.length}`);