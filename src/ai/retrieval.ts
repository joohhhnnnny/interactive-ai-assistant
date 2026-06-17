import {
  EmbeddedSourceChunk,
  listEmbeddedChunksByBook,
  listSourceChunksByBook,
  searchChunksByText,
  SourceChunk,
} from '../data/database';
import { cleanLessonText } from './textCleanup';

export type RetrievedChunk = SourceChunk & {
  score: number;
};

export type RetrievalFallbackKind = 'embedding' | 'text' | 'none';

export type RetrievalConfidence = 'none' | 'low' | 'medium' | 'high';

export type RetrievalResult = {
  chunks: RetrievedChunk[];
  fallbackKind: RetrievalFallbackKind;
  confidence: RetrievalConfidence;
  topScore: number | null;
  sourceCount: number;
};

const minimumSimilarity = 0.24;
const minimumFallbackScore = 0.35;
const maxGroundedChunkCharacters = 900;
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

function rankEmbeddedChunks(
  chunks: EmbeddedSourceChunk[],
  queryEmbedding: ArrayLike<number>,
  topK: number
): RetrievedChunk[] {
  return chunks
    .filter((chunk) => chunk.embedding && chunk.embedding.length > 0)
    .map((chunk) => ({
      ...chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding ?? []),
    }))
    .filter((chunk) => chunk.score >= minimumSimilarity)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function getSearchTerms(query: string) {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length > 2 && !searchStopWords.has(term))
    )
  ).slice(0, 8);
}

function scoreTextByTerms(text: string, terms: string[]) {
  if (terms.length === 0) {
    return 0;
  }

  const normalizedText = text.toLowerCase();
  const matchedTerms = terms.filter((term) => normalizedText.includes(term));

  return matchedTerms.length / terms.length;
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
  if (queryEmbedding) {
    const chunks = await listEmbeddedChunksByBook(bookId, embeddingModelName);
    const rankedChunks = rankEmbeddedChunks(chunks, queryEmbedding, topK);

    if (rankedChunks.length > 0) {
      return buildRetrievalResult(rankedChunks, 'embedding');
    }
  }

  const terms = getSearchTerms(query);

  if (terms.length === 0) {
    return buildRetrievalResult([], 'none');
  }

  const fallbackChunks = await searchChunksByText(bookId, terms.join(' '), topK * 2);

  const chunks = fallbackChunks
    .map((chunk) => ({
      ...chunk,
      score: scoreTextByTerms(chunk.text, terms),
    }))
    .filter((chunk) => chunk.score >= minimumFallbackScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return buildRetrievalResult(chunks, chunks.length > 0 ? 'text' : 'none');
}

export async function retrieveStudyToolChunks(
  bookId: string,
  queryEmbedding?: ArrayLike<number> | null,
  embeddingModelName?: string,
  topK = 20
): Promise<RetrievedChunk[]> {
  if (queryEmbedding) {
    const chunks = await listEmbeddedChunksByBook(bookId, embeddingModelName);
    const rankedChunks = rankEmbeddedChunks(chunks, queryEmbedding, topK);

    if (rankedChunks.length > 0) {
      return rankedChunks;
    }
  }

  const chunks = await listSourceChunksByBook(bookId, topK);

  return chunks.map((chunk, index) => ({
    ...chunk,
    score: 1 - index * 0.03,
  }));
}

export async function retrieveBookOverviewChunks(
  bookId: string,
  topK = 12
): Promise<RetrievedChunk[]> {
  const chunks = await listSourceChunksByBook(bookId, topK);

  return chunks.map((chunk, index) => ({
    ...chunk,
    score: 1 - index * 0.02,
  }));
}

export function formatSourceLabel(chunk: SourceChunk) {
  const page = chunk.pageNumber ? `, page ${chunk.pageNumber}` : '';
  return `${chunk.sourceName}${page}`;
}

export function buildGroundedMessages(question: string, chunks: RetrievedChunk[]) {
  const context = chunks
    .map((chunk, index) =>
      [
        `[Source ${index + 1}]`,
        `source: ${formatSourceLabel(chunk)}`,
        `chunk_id: ${chunk.id}`,
        `score: ${chunk.score.toFixed(3)}`,
        trimContextText(chunk.text),
      ].join('\n')
    )
    .join('\n\n');

  return [
    {
      role: 'system' as const,
      content:
        'You are ALAB, an offline study assistant for students. Answer the student using only the lesson context provided. If the lesson context is not enough, say the lesson does not have enough information yet. Keep wording simple, kind, and easy to study. Use short paragraphs with blank lines between ideas. Do not write markdown headings, hashtags, code fences, tables, or technical model and retrieval details.',
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

function trimContextText(text: string) {
  const cleanText = cleanLessonText(text).replace(/\s+/g, ' ').trim();

  if (cleanText.length <= maxGroundedChunkCharacters) {
    return cleanText;
  }

  return `${cleanText.slice(0, maxGroundedChunkCharacters).replace(/\s+\S*$/, '')}...`;
}

function buildRetrievalResult(
  chunks: RetrievedChunk[],
  fallbackKind: RetrievalFallbackKind
): RetrievalResult {
  const topScore = chunks[0]?.score ?? null;

  return {
    chunks,
    fallbackKind,
    confidence: getRetrievalConfidence(topScore, fallbackKind),
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
    if (topScore >= 0.75) return 'high';
    if (topScore >= 0.5) return 'medium';
    return 'low';
  }

  if (topScore >= 0.42) return 'high';
  if (topScore >= 0.31) return 'medium';

  return 'low';
}

export function buildStudyToolMessages(
  tool: 'quiz' | 'flashcards',
  bookTitle: string,
  chunks: RetrievedChunk[]
) {
  const request =
    tool === 'quiz'
      ? 'Create exactly 10 quiz questions from only this lesson context. Ask about concrete facts, definitions, and ideas from the lesson. Do not use phrases like "according to the PDF" or "uploaded PDF". Make every multiple-choice option unique. Use this plain format with each field on its own line and no markdown:\nQuestion: ...\nA. ...\nB. ...\nC. ...\nD. ...\nCorrect answer: A. ...\nExplanation: ...'
      : 'Create exactly 20 concise flashcards from only this lesson context. Each front must ask for a real term, fact, or idea from the lesson. Do not use phrases like "according to the PDF" or "uploaded PDF". Use this plain format with each field on its own line and no markdown:\nFront: ...\nBack: ...';

  return buildGroundedMessages(
    `${request}\nBook title: ${bookTitle}`,
    chunks
  );
}
