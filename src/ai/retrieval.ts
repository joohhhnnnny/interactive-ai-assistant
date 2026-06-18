import {
  listEmbeddedChunksByBook,
  listSourceChunksByBook,
  searchChunksByText,
  SourceChunk,
} from '../data/database';
import { cleanLessonText } from './textCleanup';

export type RetrievedChunk = SourceChunk & {
  score: number;
};

export type RetrievalFallbackKind = 'hybrid' | 'embedding' | 'text' | 'none';

export type RetrievalConfidence = 'none' | 'low' | 'medium' | 'high';

export type RetrievalResult = {
  chunks: RetrievedChunk[];
  fallbackKind: RetrievalFallbackKind;
  confidence: RetrievalConfidence;
  topScore: number | null;
  sourceCount: number;
};

type CandidateChunk = SourceChunk & {
  score: number;
  semanticScore: number;
  textScore: number;
  headingScore: number;
  intentScore: number;
  qualityScore: number;
};

const candidatePoolSize = 64;
const maxStoredChunksToScan = 220;
const maxContextChunks = 8;
const maxContextCharacters = 7200;
const maxStudyToolChunks = 18;
const minimumSemanticCandidateScore = 0.2;
const minimumHybridCandidateScore = 0.18;
const searchStopWords = new Set([
  'about',
  'after',
  'again',
  'also',
  'answer',
  'because',
  'before',
  'book',
  'could',
  'does',
  'explain',
  'from',
  'have',
  'into',
  'lesson',
  'like',
  'make',
  'mean',
  'please',
  'question',
  'should',
  'source',
  'that',
  'their',
  'there',
  'these',
  'this',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
  'your',
]);
const queryExpansionTerms: Record<string, string[]> = {
  create: ['define', 'declare', 'make', 'build', 'construct'],
  created: ['invented', 'released', 'developed', 'made'],
  data: ['value', 'information', 'variable'],
  datatype: ['type', 'class', 'structure', 'object'],
  'data type': ['type', 'datatype', 'class', 'structure'],
  difference: ['compare', 'versus', 'similar', 'contrast'],
  example: ['sample', 'instance', 'illustration'],
  function: ['method', 'procedure', 'routine'],
  list: ['outline', 'roadmap', 'topics', 'sections'],
  program: ['programming', 'software', 'code', 'instruction'],
  python: ['python'],
  section: ['topic', 'chapter', 'module', 'lesson'],
  topic: ['section', 'chapter', 'module', 'lesson'],
  type: ['datatype', 'class', 'structure', 'object'],
  variable: ['identifier', 'value', 'data'],
};

function dotProduct(left: ArrayLike<number>, right: ArrayLike<number>) {
  const length = Math.min(left.length, right.length);
  let total = 0;

  for (let index = 0; index < length; index += 1) {
    total += left[index] * right[index];
  }

  return total;
}

function magnitude(vector: ArrayLike<number>) {
  let total = 0;

  for (let index = 0; index < vector.length; index += 1) {
    total += vector[index] * vector[index];
  }

  return Math.sqrt(total);
}

function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>) {
  const denominator = magnitude(left) * magnitude(right);

  if (denominator === 0) {
    return 0;
  }

  return dotProduct(left, right) / denominator;
}

function clampScore(score: number) {
  return Math.max(0, Math.min(1, score));
}

function normalizeSemanticScore(score: number) {
  return clampScore((score - 0.16) / 0.36);
}

function normalizeToken(token: string) {
  const cleanToken = token.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (cleanToken.length <= 4) {
    return cleanToken;
  }

  return cleanToken
    .replace(/(?:ing|edly|edly|ed|es|s)$/i, '')
    .replace(/(?:tion|ions)$/i, 't');
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
}

function getSearchTerms(query: string) {
  const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const baseTerms = normalizedQuery
    .split(/\s+/)
    .map(normalizeToken)
    .filter((term) => term.length > 2 && !searchStopWords.has(term));
  const expandedTerms = new Set(baseTerms);

  for (const [phrase, expansions] of Object.entries(queryExpansionTerms)) {
    if (normalizedQuery.includes(phrase)) {
      for (const expansion of expansions) {
        const normalizedExpansion = normalizeToken(expansion);

        if (
          normalizedExpansion.length > 2 &&
          !searchStopWords.has(normalizedExpansion)
        ) {
          expandedTerms.add(normalizedExpansion);
        }
      }
    }
  }

  return Array.from(expandedTerms).slice(0, 14);
}

function getTokenCounts(text: string) {
  const counts = new Map<string, number>();

  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
}

function getTermCount(counts: Map<string, number>, term: string) {
  let total = counts.get(term) ?? 0;

  if (term.length > 4 && total === 0) {
    for (const [token, count] of counts) {
      if (token.startsWith(term) || term.startsWith(token)) {
        total += count;
      }
    }
  }

  return total;
}

function scoreTextByTerms(text: string, terms: string[]) {
  if (terms.length === 0) {
    return 0;
  }

  const counts = getTokenCounts(text);
  const wordCount = Math.max(1, tokenize(text).length);
  let matchedTerms = 0;
  let frequencyScore = 0;

  for (const term of terms) {
    const count = getTermCount(counts, term);

    if (count > 0) {
      matchedTerms += 1;
      frequencyScore += count / (count + 1.2 + 0.75 * (wordCount / 220));
    }
  }

  const coverageScore = matchedTerms / terms.length;
  const normalizedFrequency = frequencyScore / terms.length;
  const normalizedText = cleanLessonText(text).toLowerCase();
  const exactPhraseScore = terms.length > 1 && normalizedText.includes(terms.join(' '))
    ? 0.16
    : 0;

  return clampScore(
    coverageScore * 0.62 +
      normalizedFrequency * 0.28 +
      exactPhraseScore
  );
}

function getChunkHeading(text: string) {
  return text.match(/^Section:\s*(.+)$/im)?.[1]?.trim() ?? '';
}

function scoreHeadingByTerms(text: string, terms: string[]) {
  const heading = getChunkHeading(text);

  if (!heading) {
    return 0;
  }

  return scoreTextByTerms(heading, terms);
}

function scoreIntentFit(query: string, text: string) {
  const normalizedQuery = query.toLowerCase();
  const normalizedText = cleanLessonText(text).toLowerCase();
  let score = 0;

  if (/\b(what is|what are|define|meaning|means)\b/.test(normalizedQuery)) {
    if (/\b(is|are|means|refers to|defined as|called)\b/.test(normalizedText)) {
      score += 0.32;
    }
  }

  if (/\b(how|steps?|process|create|make|build|use)\b/.test(normalizedQuery)) {
    if (/\b(first|second|then|next|finally|step|process|use|create|define|declare)\b/.test(normalizedText)) {
      score += 0.3;
    }
  }

  if (/\b(when|year|date|created|released|invented)\b/.test(normalizedQuery)) {
    if (/\b(?:18|19|20)\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(normalizedText)) {
      score += 0.34;
    }
  }

  if (/\b(list|sections?|topics?|roadmap|outline|chapters?)\b/.test(normalizedQuery)) {
    if (/\b(section|topic|chapter|unit|module|lesson|overview|summary)\b/.test(normalizedText)) {
      score += 0.3;
    }
  }

  if (/\b(compare|difference|different|similar|versus|vs)\b/.test(normalizedQuery)) {
    if (/\b(similar|different|whereas|while|compared|unlike|both)\b/.test(normalizedText)) {
      score += 0.28;
    }
  }

  if (/\b(why|reason|purpose|important|benefit)\b/.test(normalizedQuery)) {
    if (/\b(because|reason|purpose|helps|important|allows|so that|therefore)\b/.test(normalizedText)) {
      score += 0.28;
    }
  }

  return clampScore(score);
}

function scoreChunkQuality(text: string) {
  const cleanText = cleanLessonText(text);
  const wordCount = tokenize(cleanText).length;
  const hasSentenceEnding = /[.!?]\s*$/.test(cleanText);
  const hasSection = Boolean(getChunkHeading(text));
  const lengthScore =
    wordCount < 35
      ? 0.2
      : wordCount <= 320
        ? 1
        : wordCount <= 460
          ? 0.82
          : 0.55;
  const sentenceScore = hasSentenceEnding ? 0.18 : 0;
  const sectionScore = hasSection ? 0.08 : 0;

  return clampScore(lengthScore * 0.74 + sentenceScore + sectionScore);
}

function scoreConceptDensity(text: string) {
  const cleanText = cleanLessonText(text);
  const definitionSignals = (cleanText.match(/\b(is|are|means|refers to|defined as|called)\b/gi) ?? []).length;
  const exampleSignals = (cleanText.match(/\b(example|for example|such as|including)\b/gi) ?? []).length;
  const processSignals = (cleanText.match(/\b(first|second|then|next|finally|step|process)\b/gi) ?? []).length;
  const namedTerms = (cleanText.match(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,3}\b/g) ?? []).length;

  return clampScore(
    definitionSignals * 0.08 +
      exampleSignals * 0.06 +
      processSignals * 0.06 +
      namedTerms * 0.025
  );
}

function toCandidate(
  chunk: SourceChunk,
  query: string,
  terms: string[],
  semanticScore = 0
): CandidateChunk {
  const textScore = scoreTextByTerms(chunk.text, terms);
  const headingScore = scoreHeadingByTerms(chunk.text, terms);
  const intentScore = scoreIntentFit(query, chunk.text);
  const qualityScore = scoreChunkQuality(chunk.text);
  const normalizedSemantic = normalizeSemanticScore(semanticScore);
  const score = clampScore(
    normalizedSemantic * 0.42 +
      textScore * 0.36 +
      headingScore * 0.08 +
      intentScore * 0.09 +
      qualityScore * 0.05
  );

  return {
    ...chunk,
    score,
    semanticScore: normalizedSemantic,
    textScore,
    headingScore,
    intentScore,
    qualityScore,
  };
}

function mergeCandidate(
  candidates: Map<string, CandidateChunk>,
  candidate: CandidateChunk
) {
  const existing = candidates.get(candidate.id);

  if (!existing || candidate.score > existing.score) {
    candidates.set(candidate.id, candidate);
  }
}

function sortCandidates(candidates: CandidateChunk[]) {
  return [...candidates].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return left.chunkIndex - right.chunkIndex;
  });
}

function selectDiverseChunks(
  candidates: CandidateChunk[],
  topK: number,
  minimumScore = minimumHybridCandidateScore
): RetrievedChunk[] {
  const selected: CandidateChunk[] = [];
  const pageCounts = new Map<string, number>();

  for (const candidate of sortCandidates(candidates)) {
    if (candidate.score < minimumScore) {
      continue;
    }

    const pageKey = `${candidate.sourceId}:${candidate.pageNumber ?? 'unknown'}`;
    const pageCount = pageCounts.get(pageKey) ?? 0;

    if (pageCount >= 2 && selected.length >= Math.ceil(topK * 0.6)) {
      continue;
    }

    selected.push(candidate);
    pageCounts.set(pageKey, pageCount + 1);

    if (selected.length >= topK) {
      break;
    }
  }

  return selected.map((candidate) => ({
    id: candidate.id,
    sourceId: candidate.sourceId,
    bookId: candidate.bookId,
    sourceName: candidate.sourceName,
    chunkIndex: candidate.chunkIndex,
    pageNumber: candidate.pageNumber,
    text: candidate.text,
    tokenEstimate: candidate.tokenEstimate,
    createdAt: candidate.createdAt,
    score: candidate.score,
  }));
}

function getRetrievalKind(candidates: CandidateChunk[]): RetrievalFallbackKind {
  if (candidates.length === 0) {
    return 'none';
  }

  const hasSemanticMatch = candidates.some((candidate) => candidate.semanticScore > 0.05);
  const hasTextMatch = candidates.some((candidate) => candidate.textScore > 0.05);

  if (hasSemanticMatch && hasTextMatch) {
    return 'hybrid';
  }

  if (hasSemanticMatch) {
    return 'embedding';
  }

  return 'text';
}

async function getHybridCandidates(
  bookId: string,
  query: string,
  queryEmbedding?: ArrayLike<number> | null,
  embeddingModelName?: string
) {
  const terms = getSearchTerms(query);
  const candidates = new Map<string, CandidateChunk>();

  if (queryEmbedding) {
    const embeddedChunks = await listEmbeddedChunksByBook(bookId, embeddingModelName);

    for (const chunk of embeddedChunks) {
      const semanticScore = chunk.embedding && chunk.embedding.length > 0
        ? cosineSimilarity(queryEmbedding, chunk.embedding)
        : 0;
      const candidate = toCandidate(chunk, query, terms, semanticScore);

      if (
        semanticScore >= minimumSemanticCandidateScore ||
        candidate.textScore > 0 ||
        candidate.headingScore > 0
      ) {
        mergeCandidate(candidates, candidate);
      }
    }
  }

  if (terms.length > 0) {
    const lexicalChunks = await searchChunksByText(
      bookId,
      terms.join(' '),
      candidatePoolSize
    );

    for (const chunk of lexicalChunks) {
      mergeCandidate(candidates, toCandidate(chunk, query, terms));
    }
  }

  return sortCandidates(Array.from(candidates.values())).slice(0, candidatePoolSize);
}

export async function retrieveRelevantChunks(
  bookId: string,
  query: string,
  queryEmbedding?: ArrayLike<number> | null,
  embeddingModelName?: string,
  topK = 5
): Promise<RetrievedChunk[]> {
  const result = await retrieveRelevantChunksWithMetadata(
    bookId,
    query,
    queryEmbedding,
    embeddingModelName,
    topK
  );

  return result.chunks;
}

export async function retrieveRelevantChunksWithMetadata(
  bookId: string,
  query: string,
  queryEmbedding?: ArrayLike<number> | null,
  embeddingModelName?: string,
  topK = 5
): Promise<RetrievalResult> {
  const candidates = await getHybridCandidates(
    bookId,
    query,
    queryEmbedding,
    embeddingModelName
  );
  const selected = selectDiverseChunks(
    candidates,
    topK,
    queryEmbedding ? minimumHybridCandidateScore : 0.12
  );
  const selectedCandidates = candidates.filter((candidate) =>
    selected.some((chunk) => chunk.id === candidate.id)
  );
  const fallbackKind = getRetrievalKind(selectedCandidates);

  return buildRetrievalResult(selected, fallbackKind);
}

export async function retrieveStudyToolChunks(
  bookId: string,
  queryEmbedding?: ArrayLike<number> | null,
  embeddingModelName?: string,
  topK = 20
): Promise<RetrievedChunk[]> {
  const chunkBudget = Math.min(Math.max(topK, 12), maxStudyToolChunks);
  const query = 'key terms concepts definitions examples processes dates comparisons causes effects';
  const terms = getSearchTerms(query);
  const candidates = new Map<string, CandidateChunk>();

  if (queryEmbedding) {
    const embeddedChunks = await listEmbeddedChunksByBook(bookId, embeddingModelName);

    for (const chunk of embeddedChunks) {
      const semanticScore = chunk.embedding && chunk.embedding.length > 0
        ? cosineSimilarity(queryEmbedding, chunk.embedding)
        : 0;
      const candidate = toCandidate(chunk, query, terms, semanticScore);
      candidate.score = clampScore(candidate.score + scoreConceptDensity(chunk.text) * 0.18);
      mergeCandidate(candidates, candidate);
    }
  }

  const sourceChunks = await listSourceChunksByBook(bookId, maxStoredChunksToScan);

  for (const chunk of sourceChunks) {
    const candidate = toCandidate(chunk, query, terms);
    candidate.score = clampScore(
      candidate.qualityScore * 0.45 +
        scoreConceptDensity(chunk.text) * 0.35 +
        getEarlyCoverageBoost(chunk) * 0.2
    );
    mergeCandidate(candidates, candidate);
  }

  return selectDiverseChunks(
    Array.from(candidates.values()),
    chunkBudget,
    0.18
  );
}

export async function retrieveBookOverviewChunks(
  bookId: string,
  topK = 12
): Promise<RetrievedChunk[]> {
  const chunks = await listSourceChunksByBook(bookId, maxStoredChunksToScan);
  const candidates = chunks.map((chunk) => {
    const candidate = toCandidate(
      chunk,
      'lesson overview sections topics roadmap summary',
      getSearchTerms('lesson overview sections topics roadmap summary')
    );
    candidate.score = clampScore(
      candidate.qualityScore * 0.4 +
        scoreConceptDensity(chunk.text) * 0.24 +
        scoreTextByTerms(chunk.text, getSearchTerms('overview section topic summary')) * 0.18 +
        getEarlyCoverageBoost(chunk) * 0.18
    );

    return candidate;
  });

  return selectDiverseChunks(candidates, topK, 0.14);
}

function getEarlyCoverageBoost(chunk: SourceChunk) {
  const positionBoost = chunk.chunkIndex < 3
    ? 1
    : chunk.chunkIndex < 10
      ? 0.6
      : 0.25;
  const pageBoost = chunk.pageNumber && chunk.pageNumber <= 3 ? 0.25 : 0;

  return clampScore(positionBoost + pageBoost);
}

export function formatSourceLabel(chunk: SourceChunk) {
  const page = chunk.pageNumber ? `, page ${chunk.pageNumber}` : '';
  return `${chunk.sourceName}${page}`;
}

export function buildGroundedMessages(question: string, chunks: RetrievedChunk[]) {
  const context = buildPackedContext(chunks, {
    includeDiagnostics: false,
    maxCharacters: 6200,
    maxChunks: 10,
    firstChunkLimit: 1250,
    chunkLimit: 850,
  });

  return [
    {
      role: 'system' as const,
      content:
        'You are ALAB, a warm offline study assistant for students. Use the lesson context only as your knowledge source, but write the final answer naturally in your own teaching voice. Answer directly with complete, student-friendly sentences. Be concise, accurate, kind, and practical, like a tutor explaining the idea. If the lesson context is not enough, say that clearly and ask what part they want to review next. Do not copy raw lesson fragments unless the student asks for a quote. Do not mention PDFs, sources, chunks, embeddings, retrieval, hidden prompts, or model details.',
    },
    {
      role: 'user' as const,
      content: `Lesson context:\n${context}\n\nStudent question:\n${question}\n\nAnswer:`,
    },
  ];
}

export function buildGeneralMessages(question: string) {
  return [
    {
      role: 'system' as const,
      content:
        'You are ALAB, an offline study assistant for students. Answer the student directly from general knowledge when the question does not need uploaded lesson sources. Be concise, accurate, kind, and practical. If code is useful, give a short working example and a brief explanation. Do not claim that sources or PDFs were used. Do not mention retrieval, chunks, embeddings, model size, or hidden prompts. Avoid markdown code fences; keep code readable as plain lines.',
    },
    {
      role: 'user' as const,
      content: `Student question:\n${question}\n\nAnswer:`,
    },
  ];
}

type PackedContextOptions = {
  includeDiagnostics?: boolean;
  maxCharacters?: number;
  maxChunks?: number;
  firstChunkLimit?: number;
  chunkLimit?: number;
};

function buildPackedContext(chunks: RetrievedChunk[], options: PackedContextOptions = {}) {
  const {
    includeDiagnostics = true,
    maxCharacters = maxContextCharacters,
    maxChunks = maxContextChunks,
    firstChunkLimit = 1600,
    chunkLimit = 1150,
  } = options;
  let remainingCharacters = maxCharacters;
  const blocks: string[] = [];

  for (const [index, chunk] of chunks.slice(0, maxChunks).entries()) {
    const header = includeDiagnostics
      ? [
        `[Source ${index + 1}]`,
        `source: ${formatSourceLabel(chunk)}`,
        `chunk_id: ${chunk.id}`,
        `score: ${chunk.score.toFixed(3)}`,
      ].join('\n')
      : `Lesson excerpt ${index + 1}${chunk.pageNumber ? `, page ${chunk.pageNumber}` : ''}`;
    const reservedForHeader = header.length + 2;
    const perChunkLimit = index === 0 ? firstChunkLimit : chunkLimit;
    const textBudget = Math.min(perChunkLimit, remainingCharacters - reservedForHeader);

    if (textBudget < 280) {
      break;
    }

    const text = trimContextText(chunk.text, textBudget);
    const block = `${header}\n${text}`;

    blocks.push(block);
    remainingCharacters -= block.length + 2;
  }

  return blocks.join('\n\n');
}

function trimContextText(text: string, maxCharacters: number) {
  const cleanText = cleanLessonText(text).replace(/\s+/g, ' ').trim();

  if (cleanText.length <= maxCharacters) {
    return cleanText;
  }

  return `${cleanText.slice(0, maxCharacters).replace(/\s+\S*$/, '')}...`;
}

function buildRetrievalResult(
  chunks: RetrievedChunk[],
  fallbackKind: RetrievalFallbackKind
): RetrievalResult {
  const topScore = chunks[0]?.score ?? null;

  return {
    chunks,
    fallbackKind: chunks.length > 0 ? fallbackKind : 'none',
    confidence: getRetrievalConfidence(topScore, chunks.length > 0 ? fallbackKind : 'none'),
    topScore,
    sourceCount: new Set(chunks.map((chunk) => chunk.sourceId)).size,
  };
}

function getRetrievalConfidence(
  topScore: number | null,
  fallbackKind: RetrievalFallbackKind
): RetrievalConfidence {
  if (topScore === null || fallbackKind === 'none') {
    return 'none';
  }

  if (fallbackKind === 'text') {
    if (topScore >= 0.62) return 'high';
    if (topScore >= 0.38) return 'medium';
    return 'low';
  }

  if (fallbackKind === 'hybrid') {
    if (topScore >= 0.58) return 'high';
    if (topScore >= 0.34) return 'medium';
    return 'low';
  }

  if (topScore >= 0.52) return 'high';
  if (topScore >= 0.3) return 'medium';

  return 'low';
}

export function buildStudyToolMessages(
  tool: 'quiz' | 'flashcards',
  bookTitle: string,
  chunks: RetrievedChunk[],
  itemCount: number,
  mode: 'mcq' | 'fill_blank' | 'essay' = 'mcq'
) {
  const quizMode =
    mode === 'fill_blank'
      ? 'Use fill-in-the-blank questions with one clear answer.'
      : mode === 'essay'
        ? 'Use short open-ended questions with a model answer.'
        : 'Use multiple-choice questions with four options.';
  const request =
    tool === 'quiz'
      ? `Create exactly ${itemCount} professor-quality quiz questions from only this lesson context. ${quizMode} Write questions as if a teacher is checking real understanding, not copying raw sentences. Cover different concepts, definitions, purposes, causes, comparisons, vocabulary, and applications from the lesson. Every question must focus on one clear concept from the lesson, not a worksheet heading, instruction word, sentence opener, or raw copied fragment such as "Consider". Every multiple-choice question must have exactly one correct answer. The correct answer should be a polished explanation in your own words using lesson knowledge. The three wrong choices must be plausible misconceptions or different concepts, clearly different from the correct answer and from each other. Do not make choices that are the same idea with words reordered or lightly rephrased. Do not reuse the same wrong choice across many questions, and do not reuse the same four-choice set on multiple questions. Do not ask generic questions such as "Which statement is true based on the lesson?" Do not mention PDFs, sources, chunks, or hidden context. Start each question with "Question 1:", "Question 2:", and so on. Use this exact plain format with each field on its own line and no markdown:\nQuestion 1: ...\nA. ...\nB. ...\nC. ...\nD. ...\nCorrect answer: A. ...\nExplanation: ...`
      : `Create exactly ${itemCount} concise flashcards from only this lesson context. Each front must be a real key term, named concept, process, person, formula, event, or specific main idea from the lesson. The front must be a complete term or main idea, not the beginning of a sentence, not a clause, and not a copied sentence fragment. Do not start fronts with words like "Since", "Because", "When", "Although", "This", "It", or "They". The back must be one or two complete student-friendly sentences that define or explain the front. The back must not continue the front. Bad example: "Front: Since Python" and "Back: is interpreted...". Good example: "Front: Python" and "Back: Python is an interpreted programming language used to write programs." Do not use generic fronts like "Text", "Here", "This", "Lesson", "Page", or "Information". Do not mention PDFs, sources, chunks, or hidden context. Use this plain format with each field on its own line and no markdown:\nFront: ...\nBack: ...`;
  const context = buildPackedContext(chunks, {
    includeDiagnostics: false,
    maxCharacters: 6200,
    maxChunks: 10,
    firstChunkLimit: 1250,
    chunkLimit: 850,
  });

  return [
    {
      role: 'system' as const,
      content:
        'You are ALAB, an offline study-tool generator for students. Use only the lesson context. Return only the requested quiz or flashcards in the exact plain-text format. Do not add introductions, summaries, markdown headings, bullets outside the requested fields, source labels, PDF wording, chunk wording, or hidden model details.',
    },
    {
      role: 'user' as const,
      content: `Book title: ${bookTitle}\n\nLesson context:\n${context}\n\nTask:\n${request}`,
    },
  ];
}
