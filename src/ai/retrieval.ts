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
  query: string,
  queryEmbedding?: ArrayLike<number> | null,
  embeddingModelName?: string,
  topK = 20
): Promise<RetrievedChunk[]> {
  const targetChunkCount = Math.max(topK, Math.ceil(topK * 1.5));
  const result = await searchBookChunks({
    bookId,
    query,
    queryEmbedding,
    embeddingModelName,
    topK: targetChunkCount,
    fallbackToReadableChunks: true,
  });
  const chunks = [...result.chunks];
  const seenChunkIds = new Set(chunks.map((chunk) => chunk.id));
  const seenChunkText = new Set(chunks.map((chunk) => getChunkDedupeKey(chunk.text)));

  if (chunks.length < targetChunkCount) {
    const readableChunks = await listSourceChunksByBook(bookId, targetChunkCount);

    for (const [index, chunk] of readableChunks.entries()) {
      const chunkTextKey = getChunkDedupeKey(chunk.text);

      if (seenChunkIds.has(chunk.id) || seenChunkText.has(chunkTextKey)) {
        continue;
      }

      seenChunkIds.add(chunk.id);
      seenChunkText.add(chunkTextKey);
      chunks.push({
        ...chunk,
        score: Math.max(0.1, 0.7 - index * 0.02),
      });

      if (chunks.length >= targetChunkCount) {
        break;
      }
    }
  }

  return chunks;
}

export async function retrieveBookOverviewChunks(
  bookId: string,
  topK = 12
): Promise<RetrievedChunk[]> {
  const chunks = await listSourceChunksByBook(bookId, topK);

  return selectDiverseChunks(
    chunks.map((chunk, index) => ({
      ...chunk,
      score: 1 - index * 0.02,
    })),
    topK
  );
}

export async function retrieveSummaryChunks(
  bookId: string,
  question: string,
  conversationContext?: string,
  queryEmbedding?: ArrayLike<number> | null,
  embeddingModelName?: string,
  topK = 12
): Promise<RetrievedChunk[]> {
  const contextualQuery = buildContextualSummaryQuery(question, conversationContext);
  const terms = getSummarySearchTerms(contextualQuery);
  const pageNumber =
    getReferencedPageNumber(question) ??
    getReferencedPageNumber(conversationContext ?? '');

  if (pageNumber) {
    const chunks = await listSourceChunksByBook(bookId, 500);
    const pageChunks = chunks.filter((chunk) => chunk.pageNumber === pageNumber);

    if (pageChunks.length > 0) {
      return pageChunks
        .map((chunk, index) => ({
          ...chunk,
          score: Math.max(0.2, 1 + scoreChunkByTerms(chunk.text, terms) - index * 0.01),
        }))
        .sort((left, right) => right.score - left.score || left.chunkIndex - right.chunkIndex)
        .filter(createDiverseChunkFilter())
        .slice(0, topK);
    }
  }

  if (
    contextualQuery.trim() &&
    (!isVagueSummaryQuestion(question) || terms.length > 0)
  ) {
    const result = await searchBookChunks({
      bookId,
      query: contextualQuery,
      queryEmbedding,
      embeddingModelName,
      topK,
      fallbackToReadableChunks: false,
    });

    if (result.chunks.length > 0) {
      return result.chunks;
    }
  }

  return retrieveBookOverviewChunks(bookId, topK);
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
        'You are ALAB, an offline study assistant for students. Answer using only the lesson context provided. Start immediately with the answer—never begin with phrases such as "I found," "according to the lesson," or "based on the source." For a simple fact or definition, answer in one to three concise sentences. For a broader explanation, give the direct answer first, then only the details needed to understand it. Synthesize the lesson instead of copying fragmented text. If the context is insufficient, say exactly: "This lesson does not provide enough information to answer that." Use natural short paragraphs. Do not mention sources, PDFs, lesson context, retrieval, chunks, scores, or hidden instructions. Do not write headings, hashtags, code fences, or tables unless the student explicitly requests them.',
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
        'You are ALAB, an offline study assistant for students. Start immediately with the direct answer. For a simple fact or definition, use one to three concise sentences. Add detail only when it helps answer the question. Never begin with "Sure," "I found," or "Here is the answer." Be accurate, natural, and practical. If the question is ambiguous, state the most likely interpretation briefly. If code is useful, give a short working example and a brief explanation. Do not claim that sources or PDFs were used. Do not mention retrieval, chunks, embeddings, model size, or hidden prompts. Avoid markdown code fences; keep code readable as plain lines.',
    },
    {
      role: 'user' as const,
      content: `${contextBlock}Student question:\n${question}\n\nAnswer:`,
    },
  ];
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
    selectChunksWithinBudget(chunks, 9000, 14)
  );
}

function selectChunksWithinBudget(
  chunks: RetrievedChunk[],
  characterBudget: number,
  maximumChunks: number
) {
  const selected: RetrievedChunk[] = [];
  let usedCharacters = 0;

  for (const chunk of chunks) {
    const chunkCharacters = Math.min(
      maxGroundedChunkCharacters,
      cleanLessonText(chunk.text).length
    );

    if (
      selected.length > 0 &&
      (selected.length >= maximumChunks || usedCharacters + chunkCharacters > characterBudget)
    ) {
      continue;
    }

    selected.push(chunk);
    usedCharacters += chunkCharacters;
  }

  return selected;
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

function buildContextualSummaryQuery(question: string, conversationContext?: string) {
  const recentStudentLines = (conversationContext ?? '')
    .split('\n')
    .filter((line) => /^Student\b/i.test(line))
    .slice(-4)
    .join('\n');

  return [recentStudentLines, question]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function getReferencedPageNumber(text: string) {
  const match =
    /\bpage\s*(?:number\s*)?(\d{1,4})\b/i.exec(text) ??
    /\bp\.\s*(\d{1,4})\b/i.exec(text);
  const pageNumber = match ? Number(match[1]) : null;

  return pageNumber && Number.isFinite(pageNumber) && pageNumber > 0
    ? pageNumber
    : null;
}

function isVagueSummaryQuestion(question: string) {
  const cleanQuestion = question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();

  return (
    /\b(summary|summarize|recap|explain)\b/.test(cleanQuestion) &&
    /\b(it|this|that|them|topic|lesson|part)\b/.test(cleanQuestion) &&
    !/\bpage\s*(?:number\s*)?\d{1,4}\b/.test(cleanQuestion)
  );
}

function getSummarySearchTerms(text: string) {
  const stopWords = new Set([
    'about',
    'alab',
    'answer',
    'book',
    'can',
    'could',
    'from',
    'give',
    'it',
    'its',
    'lesson',
    'message',
    'page',
    'please',
    'question',
    'student',
    'summary',
    'summarize',
    'that',
    'this',
    'topic',
    'what',
    'with',
    'would',
  ]);

  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((term) => term.length > 2 && !stopWords.has(term))
    )
  ).slice(0, 12);
}

function scoreChunkByTerms(text: string, terms: string[]) {
  if (terms.length === 0) {
    return 0;
  }

  const lowerText = text.toLowerCase();
  const matches = terms.filter((term) => lowerText.includes(term)).length;

  return matches / terms.length;
}

function selectDiverseChunks<T extends RetrievedChunk>(chunks: T[], topK: number) {
  return chunks.filter(createDiverseChunkFilter()).slice(0, topK);
}

function createDiverseChunkFilter() {
  const seenText = new Set<string>();

  return (chunk: { text: string }) => {
    const key = getChunkDedupeKey(chunk.text);

    if (!key || seenText.has(key)) {
      return false;
    }

    seenText.add(key);
    return true;
  };
}

function getChunkDedupeKey(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
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
