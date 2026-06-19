import {
  deleteSourceEmbeddings,
  getSourceVectorIndexStatus,
  listEmbeddedChunksByBook,
  listSourceChunksByBook,
  saveChunkEmbedding,
  searchChunksByText,
  SourceChunk,
} from '../../../data/database';

export type RagFallbackKind = 'hybrid' | 'embedding' | 'text' | 'none';

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
const vectorWeight = 0.72;
const lexicalWeight = 0.28;
const diversityWeight = 0.18;
const candidatePoolMultiplier = 6;
const searchStopWords = new Set([
  'about',
  'after',
  'again',
  'alab',
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
  'message',
  'mean',
  'please',
  'question',
  'request',
  'should',
  'source',
  'student',
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
  const terms = getSearchTerms(query);

  if (queryEmbedding) {
    const [embeddedChunks, textMatches] = await Promise.all([
      listEmbeddedChunksByBook(bookId, embeddingModelName),
      terms.length > 0
        ? searchChunksByText(bookId, terms.join(' '), topK * candidatePoolMultiplier)
        : Promise.resolve([]),
    ]);
    const candidates = new Map<string, HybridCandidate>();

    for (const chunk of embeddedChunks) {
      const vectorScore = chunk.embedding && chunk.embedding.length > 0
        ? cosineSimilarity(queryEmbedding, chunk.embedding)
        : null;
      const lexicalScore = scoreTextByTerms(chunk.text, terms);

      if (
        (vectorScore === null || vectorScore < minimumSimilarity) &&
        lexicalScore < minimumFallbackScore
      ) {
        continue;
      }

      candidates.set(chunk.id, {
        ...chunk,
        vectorScore,
        lexicalScore,
        score: buildHybridScore(vectorScore, lexicalScore),
      });
    }

    for (const chunk of textMatches) {
      if (candidates.has(chunk.id)) {
        continue;
      }

      const lexicalScore = scoreTextByTerms(chunk.text, terms);

      if (lexicalScore < minimumFallbackScore) {
        continue;
      }

      candidates.set(chunk.id, {
        ...chunk,
        embedding: null,
        vectorScore: null,
        lexicalScore,
        score: lexicalScore,
      });
    }

    const rankedChunks = [...candidates.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(topK, topK * candidatePoolMultiplier));
    const diverseChunks = selectDiverseChunks(rankedChunks, topK)
      .map(toRetrievedChunk);

    if (diverseChunks.length > 0) {
      const usedLexicalSignal = rankedChunks.some(
        (chunk) => chunk.lexicalScore >= minimumFallbackScore
      );
      const usedVectorSignal = rankedChunks.some(
        (chunk) => chunk.vectorScore !== null && chunk.vectorScore >= minimumSimilarity
      );
      const fallbackKind: RagFallbackKind = usedLexicalSignal && usedVectorSignal
        ? 'hybrid'
        : usedVectorSignal
          ? 'embedding'
          : 'text';

      return buildSearchResult(diverseChunks, fallbackKind);
    }
  }

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
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
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

  const normalizedText = normalizeSearchText(text);
  const matchedTerms = terms.filter((term) => normalizedText.includes(term));
  const termCoverage = matchedTerms.length / terms.length;
  const occurrenceScore = matchedTerms.reduce((total, term) => {
    return total + Math.min(3, countOccurrences(normalizedText, term));
  }, 0) / (terms.length * 3);
  const adjacentPairs = terms
    .slice(0, -1)
    .map((term, index) => `${term} ${terms[index + 1]}`);
  const pairScore = adjacentPairs.length > 0
    ? adjacentPairs.filter((pair) => normalizedText.includes(pair)).length /
      adjacentPairs.length
    : 0;

  return clamp(termCoverage * 0.72 + occurrenceScore * 0.18 + pairScore * 0.1);
}

type HybridCandidate = RagRetrievedChunk & {
  embedding?: number[] | null;
  embeddingModelName?: string | null;
  vectorScore: number | null;
  lexicalScore: number;
};

function buildHybridScore(vectorScore: number | null, lexicalScore: number) {
  if (vectorScore === null) {
    return lexicalScore;
  }

  if (lexicalScore === 0) {
    return clamp(vectorScore);
  }

  return clamp(
    clamp(vectorScore) * vectorWeight + lexicalScore * lexicalWeight
  );
}

function selectDiverseChunks<T extends RagRetrievedChunk>(chunks: T[], topK: number) {
  const seenText = new Set<string>();
  const selected: T[] = [];
  const remaining = chunks.filter((chunk) => {
    const key = getChunkDedupeKey(chunk.text);

    if (!key || seenText.has(key)) {
      return false;
    }

    seenText.add(key);
    return true;
  });

  while (remaining.length > 0 && selected.length < topK) {
    let bestIndex = 0;
    let bestAdjustedScore = Number.NEGATIVE_INFINITY;

    for (const [index, candidate] of remaining.entries()) {
      const maximumOverlap = selected.reduce(
        (maximum, selectedChunk) =>
          Math.max(maximum, textSimilarity(candidate.text, selectedChunk.text)),
        0
      );
      const hasNewSource = selected.every(
        (selectedChunk) => selectedChunk.sourceId !== candidate.sourceId
      );
      const adjustedScore =
        candidate.score * (1 - diversityWeight) -
        maximumOverlap * diversityWeight +
        (hasNewSource ? 0.025 : 0);

      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestIndex = index;
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
}

function toRetrievedChunk(candidate: HybridCandidate): RagRetrievedChunk {
  const {
    embedding: _embedding,
    embeddingModelName: _embeddingModelName,
    vectorScore: _vectorScore,
    lexicalScore: _lexicalScore,
    ...chunk
  } = candidate;

  return chunk;
}

function textSimilarity(left: string, right: string) {
  const leftTerms = new Set(getContentTerms(left));
  const rightTerms = new Set(getContentTerms(right));

  if (leftTerms.size === 0 || rightTerms.size === 0) {
    return 0;
  }

  let intersectionSize = 0;

  for (const term of leftTerms) {
    if (rightTerms.has(term)) {
      intersectionSize += 1;
    }
  }

  return intersectionSize / (leftTerms.size + rightTerms.size - intersectionSize);
}

function getContentTerms(text: string) {
  return normalizeSearchText(text)
    .split(/\s+/)
    .filter((term) => term.length > 2 && !searchStopWords.has(term))
    .slice(0, 120);
}

function normalizeSearchText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countOccurrences(text: string, term: string) {
  let count = 0;
  let position = 0;

  while (position < text.length) {
    const matchIndex = text.indexOf(term, position);

    if (matchIndex < 0) {
      break;
    }

    count += 1;
    position = matchIndex + term.length;
  }

  return count;
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
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
