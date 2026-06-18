import { listSourceChunksByBook, SourceChunk } from '../data/database';
import {
  RagFallbackKind,
  RagRetrievedChunk,
  searchBookChunks,
} from './rag/vector-store/store';
import { cleanLessonText } from './textCleanup';

export type RetrievedChunk = RagRetrievedChunk;

export type RetrievalFallbackKind = RagFallbackKind;

export type RetrievalConfidence = 'none' | 'low' | 'medium' | 'high';

export type RetrievalResult = {
  chunks: RetrievedChunk[];
  fallbackKind: RetrievalFallbackKind;
  confidence: RetrievalConfidence;
  topScore: number | null;
  sourceCount: number;
};

const maxGroundedChunkCharacters = 900;

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
  const result = await searchBookChunks({
    bookId,
    query,
    queryEmbedding,
    embeddingModelName,
    topK,
  });

  return buildRetrievalResult(result.chunks, result.fallbackKind);
}

export async function retrieveStudyToolChunks(
  bookId: string,
  queryEmbedding?: ArrayLike<number> | null,
  embeddingModelName?: string,
  topK = 20
): Promise<RetrievedChunk[]> {
  const result = await searchBookChunks({
    bookId,
    query: 'key terms concepts definitions lesson facts',
    queryEmbedding,
    embeddingModelName,
    topK,
    fallbackToReadableChunks: true,
  });

  return result.chunks;
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

export function buildGroundedMessages(
  question: string,
  chunks: RetrievedChunk[],
  conversationContext?: string
) {
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
      content: [
        `Lesson context:\n${context}`,
        conversationContext
          ? `Recent conversation for continuity:\n${conversationContext}`
          : null,
        `Student question:\n${question}`,
        'Answer:',
      ].filter(Boolean).join('\n\n'),
    },
  ];
}

export function buildGeneralMessages(question: string, conversationContext?: string) {
  const contextBlock = conversationContext
    ? `Recent conversation for continuity:\n${conversationContext}\n\n`
    : '';

  return [
    {
      role: 'system' as const,
      content:
        'You are ALAB, an offline study assistant for students. Answer the student directly from general knowledge when the question does not need uploaded lesson sources. Be concise, accurate, kind, and practical. If code is useful, give a short working example and a brief explanation. Do not claim that sources or PDFs were used. Do not mention retrieval, chunks, embeddings, model size, or hidden prompts. Avoid markdown code fences; keep code readable as plain lines.',
    },
    {
      role: 'user' as const,
      content: `${contextBlock}Student question:\n${question}\n\nAnswer:`,
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
  chunks: RetrievedChunk[],
  options?: {
    itemCount?: number;
    mode?: 'mcq' | 'fill_blank' | 'essay';
    conversationContext?: string;
  }
) {
  const itemCount = options?.itemCount ?? (tool === 'quiz' ? 10 : 20);
  const mode = options?.mode ?? 'mcq';
  const request = tool === 'quiz'
    ? buildQuizRequest(itemCount, mode)
    : buildFlashcardRequest(itemCount);

  const contextBlock = options?.conversationContext
    ? `\nRecent conversation:\n${options.conversationContext}\nWhen possible, avoid repeating previous quiz questions, flashcards, or examples.`
    : '';

  return buildGroundedMessages(
    `${request}\nBook title: ${bookTitle}${contextBlock}`,
    chunks
  );
}

function buildQuizRequest(
  itemCount: number,
  mode: 'mcq' | 'fill_blank' | 'essay'
) {
  if (mode === 'fill_blank') {
    return [
      `Create exactly ${itemCount} fill-in-the-blank quiz questions from only this lesson context.`,
      'Use concrete facts, definitions, and ideas from the lesson.',
      'Each blank must have one clear answer from the lesson.',
      'Do not use phrases like "according to the PDF" or "uploaded PDF".',
      'Use this plain format with each field on its own line and no markdown:',
      'Question: ...',
      'Answer: ...',
      'Explanation: ...',
    ].join('\n');
  }

  if (mode === 'essay') {
    return [
      `Create exactly ${itemCount} short essay quiz questions from only this lesson context.`,
      'Ask questions that help the student explain real ideas from the lesson.',
      'Provide a concise model answer and one grading hint.',
      'Do not use phrases like "according to the PDF" or "uploaded PDF".',
      'Use this plain format with each field on its own line and no markdown:',
      'Question: ...',
      'Answer: ...',
      'Explanation: ...',
    ].join('\n');
  }

  return [
    `Create exactly ${itemCount} multiple-choice quiz questions from only this lesson context.`,
    'Ask about concrete facts, definitions, and ideas from the lesson.',
    'Every question must be answerable from the lesson context.',
    'Every question must have exactly four unique options: A, B, C, and D.',
    'The correct answer must be one of the displayed options.',
    'Do not use phrases like "according to the PDF" or "uploaded PDF".',
    'Do not invent facts that are not in the lesson context.',
    'Use this plain format with each field on its own line and no markdown:',
    'Question: ...',
    'A. ...',
    'B. ...',
    'C. ...',
    'D. ...',
    'Correct answer: A. ...',
    'Explanation: ...',
  ].join('\n');
}

function buildFlashcardRequest(itemCount: number) {
  return [
    `Create exactly ${itemCount} concise flashcards from only this lesson context.`,
    'Each front must ask for a real term, fact, or idea from the lesson.',
    'Each back must be short, accurate, and easy for a student to review.',
    'Do not use phrases like "according to the PDF" or "uploaded PDF".',
    'Do not invent facts that are not in the lesson context.',
    'Use this plain format with each field on its own line and no markdown:',
    'Front: ...',
    'Back: ...',
  ].join('\n');
}
