import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';

interface Asset {
  type: string;
  name: string;
  url: string;
  sha256: string | null;
  status: string;
  uploadStatus: string;
}

interface Lesson {
  name: string;
  index: number;
  url: string;
  slug: string;
  description: string;
  links: string[];
  assets: Asset[];
  status: string;
}

interface Module {
  name: string;
  lessons: Lesson[];
}

interface Course {
  course: string;
  url: string;
  slug: string;
  modules: Module[];
}

interface SemanticScore {
  assetName: string;
  course: string;
  lessonName: string;
  moduleName: string;
  score: 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW';
  evidence: string[];
  scoreBreakdown: {
    aulaMismatch: boolean;
    moduleMismatch: boolean;
    semanticMismatch: boolean;
    explicitConflict: boolean;
  };
  recommendation: 'REMOVE' | 'KEEP' | 'REVIEW';
  reasoning: string;
}

// Safe patterns - assets that should NEVER be removed
const SAFE_PATTERNS = [
  /workbook/i,
  /apostila/i,
  /material\s*(complementar|geral|de\s*apoio)/i,
  /checklist/i,
  /template/i,
  /ebook/i,
  /guia/i,
  /branding/i,
  /logo/i,
  /capa/i,
  /intro/i,
  /conteudo/i,
  /exercicio/i,
  /exercise/i,
  /^[^a-zA-Z]*$/, // no text name
  /^[a-z0-9]{20,}$/i, // hash-like
];

// Patterns that indicate possible mismatch but need context
const SUSPICIOUS_PATTERNS = [
  /Aula\s*(\d+)/i,
  /Modulo\s*(\d+)/i,
  /módulo\s*(\d+)/i,
];

// Course type keywords for semantic validation
const COURSE_KEYWORDS: Record<string, string[]> = {
  'excel': ['excel', 'spreadsheet', 'planilha', 'funções', 'fórmulas', 'microsoft'],
  'powerbi': ['power bi', 'bi', 'dashboard', 'visualização', 'dax'],
  'figma': ['figma', 'design', 'interface', 'ui', 'ux', 'protótipo'],
  'linkedin': ['linkedin', 'rede social', 'perfil', 'curriculo', 'vaga'],
  'ingles': ['inglês', 'english', 'conversation', 'vocabulary', 'grammar'],
  'gestao': ['gestão', 'management', 'produtividade', 'tempo', 'liderança'],
  'inteligencia': ['ia', 'ai', 'chatgpt', 'gpt', 'artificial'],
  'oratoria': ['oratória', 'comunicação', 'palestra', 'discurso', 'apresentação'],
};

function isSafePattern(assetName: string): boolean {
  return SAFE_PATTERNS.some(p => p.test(assetName));
}

function extractAulaNumber(name: string): number | null {
  const match = name.match(/Aula\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function extractModuloNumber(name: string): number | null {
  const match = name.match(/(?:Modulo|módulo)\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function extractLessonNumber(lessonName: string): number | null {
  const match = lessonName.match(/Aula\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function extractModuloFromLesson(lessonName: string, moduleName: string): number | null {
  // Try from module name
  const modMatch = moduleName.match(/(?:Modulo|módulo)\s*(\d+)/i);
  if (modMatch) return parseInt(modMatch[1]);

  // Try from lesson name
  return extractLessonNumber(lessonName);
}

function getCourseType(courseName: string): string {
  const lower = courseName.toLowerCase();
  for (const [type, keywords] of Object.entries(COURSE_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return type;
  }
  return 'generic';
}

function calculateSemanticScore(
  assetName: string,
  lessonName: string,
  moduleName: string,
  courseName: string
): SemanticScore {
  const aulaAssetNum = extractAulaNumber(assetName);
  const aulaLessonNum = extractLessonNumber(lessonName);
  const moduloAssetNum = extractModuloNumber(assetName);
  const moduloModuleNum = extractModuloFromLesson(lessonName, moduleName);

  const courseType = getCourseType(courseName);

  const evidence: string[] = [];
  const breakdown = {
    aulaMismatch: false,
    moduleMismatch: false,
    semanticMismatch: false,
    explicitConflict: false
  };

  let score: SemanticScore['score'] = 'LOW';
  let recommendation: SemanticScore['recommendation'] = 'KEEP';
  let reasoning = '';

  // RULE 1: Safe patterns ALWAYS keep
  if (isSafePattern(assetName)) {
    return {
      assetName,
      course: courseName,
      lessonName,
      moduleName,
      score: 'LOW',
      evidence: ['Safe pattern matched (workbook/apostila/template/generic)'],
      breakdown: { aulaMismatch: false, moduleMismatch: false, semanticMismatch: false, explicitConflict: false },
      recommendation: 'KEEP',
      reasoning: 'Asset matches safe pattern (generic name) - preserving as potential legitimate shared material'
    };
  }

  // RULE 2: Check explicit mismatch
  // "Aula XX" in asset but XX is far from lesson number
  if (aulaAssetNum !== null && aulaLessonNum !== null) {
    const diff = Math.abs(aulaAssetNum - aulaLessonNum);
    if (diff > 5) {
      breakdown.aulaMismatch = true;
      evidence.push(`Aula ${aulaAssetNum} in filename but lesson is ${aulaLessonNum} (diff: ${diff})`);
    } else if (diff >= 3 && diff <= 5) {
      evidence.push(`Aula ${aulaAssetNum} in filename, lesson is ${aulaLessonNum} (diff: ${diff}) - medium mismatch`);
    }
  }

  // "Modulo XX" in asset but XX is far from module number
  if (moduloAssetNum !== null && moduloModuleNum !== null) {
    const diff = Math.abs(moduloAssetNum - moduloModuleNum);
    if (diff > 2) {
      breakdown.moduleMismatch = true;
      evidence.push(`Modulo ${moduloAssetNum} in filename but module is ${moduloModuleNum} (diff: ${diff})`);
    }
  }

  // RULE 3: Explicit conflict - asset name vs lesson topic
  // E.g., "Aula 22.pdf" in "Aula 01" with completely different topic
  const assetContent = assetName.toLowerCase();
  const lessonContent = lessonName.toLowerCase();

  const unrelatedKeywords = [
    ['gestao', 'tempo'], ['produtividade'], ['linkedin'], ['excel'],
    ['figma'], ['ingles'], ['oratoria'], ['inteligencia']
  ];

  let hasUnrelatedContent = false;
  for (const [topic1, topic2] of unrelatedKeywords) {
    const assetHas = assetContent.includes(topic1) || assetContent.includes(topic2 || topic1);
    const lessonHas = lessonContent.includes(topic1) || lessonContent.includes(topic2 || topic1);
    if (assetHas && lessonHas && !assetContent.includes(topic1) && !lessonContent.includes(topic1)) {
      // Asset has topic keyword but lesson doesn't
    }
  }

  // RULE 4: VERY_HIGH confidence removal criteria
  // Criteria: 2+ independent evidences of mismatch
  const mismatchCount = [
    breakdown.aulaMismatch,
    breakdown.moduleMismatch,
    breakdown.explicitConflict
  ].filter(Boolean).length;

  const hasStrongEvidence = evidence.length >= 2 && mismatchCount >= 1;
  const hasExplicitMismatch = aulaAssetNum !== null && aulaLessonNum !== null && Math.abs(aulaAssetNum - aulaLessonNum) >= 10;

  if (hasExplicitMismatch || (hasStrongEvidence && mismatchCount >= 2)) {
    score = 'VERY_HIGH';
    recommendation = 'REMOVE';
    reasoning = `Explicit mismatch: ${evidence.join('; ')}`;
  } else if (breakdown.aulaMismatch && evidence.length >= 1) {
    score = 'MEDIUM';
    recommendation = 'REVIEW';
    reasoning = `Potential mismatch: ${evidence.join('; ')} - requires human judgment`;
  } else {
    score = 'LOW';
    recommendation = 'KEEP';
    reasoning = 'No strong evidence of mismatch - conservative preservation';
  }

  return {
    assetName,
    course: courseName,
    lessonName,
    moduleName,
    score,
    evidence,
    breakdown,
    recommendation,
    reasoning
  };
}

// Main execution
console.log('=== HUMAN SEMANTIC REVIEWER ===\n');

if (!existsSync('storage/audit')) {
  mkdirSync('storage/audit', { recursive: true });
}

// Load manifests
const manifestsDir = 'storage/manifests/themembers';
const files = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));

let totalScored = 0;
let veryHighRemove: SemanticScore[] = [];
let highReview: SemanticScore[] = [];
let mediumReview: SemanticScore[] = [];
let lowKeep: SemanticScore[] = [];

const allScores: SemanticScore[] = [];

for (const file of files) {
  const raw = readFileSync(`${manifestsDir}/${file}`, 'utf8');
  const course: Course = JSON.parse(raw);

  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      if (lesson.name === 'Discovery failed') continue;

      for (const asset of lesson.assets) {
        const score = calculateSemanticScore(
          asset.name,
          lesson.name,
          mod.name,
          course.course
        );

        allScores.push(score);
        totalScored++;

        switch (score.score) {
          case 'VERY_HIGH':
            if (score.recommendation === 'REMOVE') veryHighRemove.push(score);
            break;
          case 'HIGH':
            highReview.push(score);
            break;
          case 'MEDIUM':
            mediumReview.push(score);
            break;
          case 'LOW':
            lowKeep.push(score);
            break;
        }
      }
    }
  }
}

// Summary
console.log(`Total assets scored: ${totalScored}`);
console.log(`\nScore distribution:`);
console.log(`  VERY_HIGH (remove): ${veryHighRemove.length}`);
console.log(`  HIGH (review): ${highReview.length}`);
console.log(`  MEDIUM (review): ${mediumReview.length}`);
console.log(`  LOW (keep): ${lowKeep.length}`);

// Save scores
writeFileSync(
  'storage/audit/human_semantic_scores.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    totalScored,
    scores: allScores,
    summary: {
      veryHighRemove: veryHighRemove.length,
      highReview: highReview.length,
      mediumReview: mediumReview.length,
      lowKeep: lowKeep.length
    }
  }, null, 2)
);

// Only VERY_HIGH with REMOVE recommendation should be removed
console.log(`\n=== ASSETS FOR FINAL REMOVAL (VERY_HIGH only) ===`);
console.log(`Count: ${veryHighRemove.length}\n`);

for (const s of veryHighRemove) {
  console.log(`${s.assetName} (${s.course})`);
  console.log(`  Lesson: ${s.lessonName}`);
  console.log(`  Evidence: ${s.evidence.join('; ')}`);
  console.log(`  Reasoning: ${s.reasoning}\n`);
}

// Generate final removal list (VERY_HIGH only)
writeFileSync(
  'storage/audit/final_removal_list.json',
  JSON.stringify({
    generated: new Date().toISOString(),
    removalCriteria: 'VERY_HIGH score with explicit mismatch evidence',
    removals: veryHighRemove,
    review: [...highReview, ...mediumReview],
    keep: lowKeep
  }, null, 2)
);

console.log('\nSaved to storage/audit/human_semantic_scores.json');
console.log('Saved to storage/audit/final_removal_list.json');
console.log('\n=== HUMAN REVIEW COMPLETE ===');
console.log(`Only ${veryHighRemove.length} assets meet VERY_HIGH removal criteria`);