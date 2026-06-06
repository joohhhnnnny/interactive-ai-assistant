import {
  EmbeddedSourceChunk,
  listEmbeddedChunksByBook,
  searchChunksByText,
  SourceChunk,
} from '../data/database';

export type RetrievedChunk = SourceChunk & {
  score: number;
};

const minimumSimilarity = 0.16;

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

export async function retrieveRelevantChunks(
  bookId: string,
  query: string,
  queryEmbedding?: ArrayLike<number> | null,
  topK = 5
): Promise<RetrievedChunk[]> {
  if (queryEmbedding) {
    const chunks = await listEmbeddedChunksByBook(bookId);
    const rankedChunks = rankEmbeddedChunks(chunks, queryEmbedding, topK);

    if (rankedChunks.length > 0) {
      return rankedChunks;
    }
  }

  const fallbackChunks = await searchChunksByText(bookId, query, topK);

  return fallbackChunks.map((chunk, index) => ({
    ...chunk,
    score: 1 - index * 0.05,
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
        chunk.text.trim(),
      ].join('\n')
    )
    .join('\n\n');

  return [
    {
      role: 'system' as const,
      content:
        'You are ALAB, an offline study assistant for students. Answer using the provided lesson context first. If the context is not enough, say the lesson does not have enough information yet, then give one brief study hint only if it helps. Keep wording simple, kind, and easy for students to follow. Do not mention technical model or retrieval details.',
    },
    {
      role: 'user' as const,
      content: `Lesson context:\n${context}\n\nStudent question:\n${question}\n\nAnswer:`,
    },
  ];
}

export function buildStudyToolMessages(
  tool: 'quiz' | 'flashcards',
  bookTitle: string,
  chunks: RetrievedChunk[]
) {
  const request =
    tool === 'quiz'
      ? 'Create a short 3-question quiz from only this lesson context. Prefer multiple choice. Use this exact clear format for each item: Question: ... then A. ... B. ... C. ... D. ... Correct answer: ... Explanation: ...'
      : 'Create 6 concise flashcards from only this lesson context. Use this exact clear format for each card: Front: ... on one line, then Back: ... on the next line. Keep each back easy to review.';

  return buildGroundedMessages(
    `${request}\nBook title: ${bookTitle}`,
    chunks
  );
}
