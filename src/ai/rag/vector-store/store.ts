import {
  deleteSourceEmbeddings,
  getSourceVectorIndexStatus,
  listEmbeddedChunksByBook,
  listSourceChunksByBook,
  saveChunkEmbedding,
  searchChunksByText,
  SourceChunk,
} from '../../../data/database';

export type RagFallbackKind = 'embedding' | 'text' | 'none';

export type RagIndexStatus = {
  sourceId: string;
  chunkCount: number;
  embeddingCount: number;
  isSearchable: boolean;
  isFullyEmbedded: boolean;
};

export type RagSearchResult = {
  chunks: RagRetrievedChunk[];
  fallbackKind: RagFallbackKind;
  topScore: number | null;
  sourceCount: number;
};

export type RagRetrievedChunk = SourceChunk & {
  score: number;
};

const minimumSimilarity = 0.24;
const minimumFallbackScore = 0.35;
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

export async function indexSourceChunks(
  sourceId: string,
  chunks: SourceChunk[],
  options: {
    embedText?: (text: string) => Promise<ArrayLike<number> | null>;
    modelName?: string;
    onIndexedChunk?: (current: number, total: number) => void;
  }
): Promise<RagIndexStatus> {
  let embeddingCount = 0;

  if (options.embedText && options.modelName) {
    for (const [index, chunk] of chunks.entries()) {
      options.onIndexedChunk?.(index + 1, chunks.length);
      const embedding = await options.embedText(chunk.text);

      if (!embedding) {
        break;
      }

      await saveChunkEmbedding(chunk.id, options.modelName, embedding);
      embeddingCount += 1;
    }
  }

  return {
    sourceId,
    chunkCount: chunks.length,
    embeddingCount,
    isSearchable: chunks.length > 0,
    isFullyEmbedded: chunks.length > 0 && embeddingCount === chunks.length,
  };
}

export async function searchBookChunks({
  bookId,
  query,
  queryEmbedding,
  embeddingModelName,
  topK = 5,
  fallbackToReadableChunks = false,
}: {
  bookId: string;
  query: string;
  queryEmbedding?: ArrayLike<number> | null;
  embeddingModelName?: string;
  topK?: number;
  fallbackToReadableChunks?: boolean;
}): Promise<RagSearchResult> {
  if (queryEmbedding) {
    const chunks = await listEmbeddedChunksByBook(bookId, embeddingModelName);
    const rankedChunks = chunks
      .filter((chunk) => chunk.embedding && chunk.embedding.length > 0)
      .map((chunk) => ({
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding ?? []),
      }))
      .filter((chunk) => chunk.score >= minimumSimilarity)
      .sort((a, b) => b.score - a.score);
    const diverseChunks = selectDiverseChunks(rankedChunks, topK);

    if (diverseChunks.length > 0) {
      return buildSearchResult(diverseChunks, 'embedding');
    }
  }

  const terms = getSearchTerms(query);

  if (terms.length > 0) {
    const fallbackChunks = await searchChunksByText(bookId, terms.join(' '), topK * 2);
    const chunks = fallbackChunks
      .map((chunk) => ({
        ...chunk,
        score: scoreTextByTerms(chunk.text, terms),
      }))
      .filter((chunk) => chunk.score >= minimumFallbackScore)
      .sort((a, b) => b.score - a.score);
    const diverseChunks = selectDiverseChunks(chunks, topK);

    if (diverseChunks.length > 0) {
      return buildSearchResult(diverseChunks, 'text');
    }
  }

  if (fallbackToReadableChunks) {
    const chunks = await listSourceChunksByBook(bookId, topK);

    const fallbackChunks = chunks.map((chunk, index) => ({
      ...chunk,
      score: 1 - index * 0.03,
    }));

    return buildSearchResult(
      selectDiverseChunks(fallbackChunks, topK),
      chunks.length > 0 ? 'text' : 'none'
    );
  }

  return buildSearchResult([], 'none');
}

export async function deleteSourceIndex(sourceId: string) {
  await deleteSourceEmbeddings(sourceId);
}

export async function getIndexStatus(sourceId: string): Promise<RagIndexStatus> {
  return getSourceVectorIndexStatus(sourceId);
}

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

function selectDiverseChunks<T extends RagRetrievedChunk>(chunks: T[], topK: number) {
  const seenText = new Set<string>();
  const selected: T[] = [];

  for (const chunk of chunks) {
    const key = getChunkDedupeKey(chunk.text);

    if (!key || seenText.has(key)) {
      continue;
    }

    seenText.add(key);
    selected.push(chunk);

    if (selected.length >= topK) {
      break;
    }
  }

  return selected;
}

function getChunkDedupeKey(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function buildSearchResult(
  chunks: RagRetrievedChunk[],
  fallbackKind: RagFallbackKind
): RagSearchResult {
  return {
    chunks,
    fallbackKind,
    topScore: chunks[0]?.score ?? null,
    sourceCount: new Set(chunks.map((chunk) => chunk.sourceId)).size,
  };
}
