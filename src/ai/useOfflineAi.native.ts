import { useCallback, useEffect, useState } from 'react';
import {
  isAvailable,
  Message,
  useLLM,
  useTextEmbeddings,
} from 'react-native-executorch';
import {
  getAppSetting,
  hasReadySources,
  hasReadyStudyChunks,
  saveAiPerformanceMetric,
  saveGeneratedFlashcards,
  saveGeneratedQuiz,
} from '../data/database';
import type { AiAnswerConfidence, AiAnswerMode } from '../data/database';
import {
  buildGeneralMessages,
  buildGroundedMessages,
  formatSourceLabel,
  retrieveBookOverviewChunks,
  retrieveRelevantChunksWithMetadata,
  retrieveStudyToolChunks,
} from './retrieval';
import {
  embeddingModelName,
  formatEmbeddingInput,
  modelDownloadedKey,
  modelProfileKey,
  offlineEmbeddingModel,
  offlineLlmModel,
  offlineModelProfile,
} from './offlineModelResources.native';
import {
  cleanLessonText,
  formatGeneralOutput,
  formatStudentOutput,
  splitReadableSentences,
} from './textCleanup';

type OfflineAiResponse = {
  text: string;
  sources: string[];
  answerMode: AiAnswerMode;
  confidence?: AiAnswerConfidence;
  metrics?: OfflineAiMetrics;
};

export type StudyToolMode = 'mcq' | 'fill_blank' | 'essay';

type OfflineAiMetrics = {
  retrievalMs?: number;
  generationMs?: number;
  totalMs?: number;
  sourceCount?: number;
  topScore?: number | null;
  fallbackReason?: string | null;
};

type AnswerIntent = 'general' | 'grounded' | 'summary';

const heavyAnswerTimeoutMs = 30000;
const quizItemCount = 10;
const maxQuizItemCount = 50;
const flashcardItemCount = 20;
const generationConfig = {
  temperature: 0.2,
  topP: 0.82,
  minP: 0.05,
  repetitionPenalty: 1.08,
  outputTokenBatchSize: 4,
  batchTimeInterval: 80,
};

export function useOfflineAi(bookId: string, bookTitle: string) {
  const [shouldLoadEmbeddings, setShouldLoadEmbeddings] = useState(false);
  const [shouldLoadLlm, setShouldLoadLlm] = useState(false);
  const [hasCheckedDownload, setHasCheckedDownload] = useState(false);
  const llm = useLLM({
    model: offlineLlmModel,
    preventLoad: !shouldLoadLlm,
  });
  const embeddings = useTextEmbeddings({
    model: offlineEmbeddingModel,
    preventLoad: !shouldLoadEmbeddings,
  });

  useEffect(() => {
    let isActive = true;

    Promise.all([
      getAppSetting(modelDownloadedKey),
      getAppSetting(modelProfileKey),
    ])
      .then(([downloadedValue, profileValue]) => {
        if (isActive && downloadedValue === 'true' && profileValue === offlineModelProfile) {
          setShouldLoadEmbeddings(true);
        }
      })
      .finally(() => {
        if (isActive) {
          setHasCheckedDownload(true);
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  const answerQuestion = useCallback(
    async (question: string): Promise<OfflineAiResponse> => {
      const startedAt = Date.now();
      const makeResponse = async ({
        text,
        sources = [],
        answerMode,
        confidence = 'none',
        retrievalMs,
        generationMs,
        topScore = null,
        fallbackReason = null,
      }: {
        text: string;
        sources?: string[];
        answerMode: AiAnswerMode;
        confidence?: AiAnswerConfidence;
        retrievalMs?: number;
        generationMs?: number;
        topScore?: number | null;
        fallbackReason?: string | null;
      }): Promise<OfflineAiResponse> => {
        const metrics: OfflineAiMetrics = {
          retrievalMs,
          generationMs,
          totalMs: Date.now() - startedAt,
          sourceCount: sources.length,
          topScore,
          fallbackReason,
        };

        try {
          const showedSources = answerMode !== 'status' && sources.length > 0;

          await saveAiPerformanceMetric({
            bookId,
            answerMode,
            confidence,
            retrievalMs,
            generationMs,
            totalMs: metrics.totalMs,
            sourceCount: sources.length,
            topScore,
            fallbackReason,
            outputLength: text.length,
            showedSources,
          });
        } catch {
          // The answer should still work if local metrics cannot be saved.
        }

        return {
          text,
          sources,
          answerMode,
          confidence,
          metrics,
        };
      };

      if (!isAvailable) {
        return makeResponse({
          text: 'The study helper is not available on this device yet.',
          answerMode: 'status',
          fallbackReason: 'executorch_unavailable',
        });
      }

      if (!hasCheckedDownload) {
        return makeResponse({
          text: 'Checking your saved study helper...',
          answerMode: 'status',
          fallbackReason: 'checking_download',
        });
      }

      if (!shouldLoadEmbeddings) {
        return makeResponse({
          text: 'Please prepare the study helper from My Books first.',
          answerMode: 'status',
          fallbackReason: 'model_not_prepared',
        });
      }

      const hasSources = await hasReadySources(bookId);
      const intent = getAnswerIntent(question, hasSources);

      if (!hasSources && intent !== 'general') {
        return makeResponse({
          text: 'I need a ready source before I can answer from this book.',
          answerMode: 'status',
          fallbackReason: 'no_ready_sources',
        });
      }

      if (intent === 'summary') {
        const retrievalStartedAt = Date.now();
        const chunks = await retrieveBookOverviewChunks(bookId, 12);
        const retrievalMs = Date.now() - retrievalStartedAt;

        if (chunks.length === 0) {
          return makeResponse({
            text: 'I could not find readable PDF text to summarize yet.',
            answerMode: 'summary',
            retrievalMs,
            fallbackReason: 'no_summary_chunks',
          });
        }

        const sources = chunks.slice(0, 5).map(formatSourceLabel);

        return makeResponse({
          text: buildPdfSummary(chunks),
          sources,
          answerMode: 'summary',
          confidence: 'medium',
          retrievalMs,
          topScore: chunks[0]?.score ?? null,
        });
      }

      if (intent === 'general') {
        if (llm.error) {
          return makeResponse({
            text: 'The larger study helper had trouble opening on this device. Please close other apps and try again, or switch back to the lighter study helper.',
            answerMode: 'status',
            fallbackReason: 'llm_error',
          });
        }

        if (!shouldLoadLlm) {
          setShouldLoadLlm(true);
          return makeResponse({
            text: 'The larger study helper is opening now, so please ask again in a moment.',
            answerMode: 'status',
            fallbackReason: 'llm_lazy_loading',
          });
        }

        if (!llm.isReady) {
          const progress = Math.round(llm.downloadProgress * 100);
          return makeResponse({
            text: `The study helper is still getting ready${progress > 0 ? ` (${progress}%)` : ''}.`,
            answerMode: 'status',
            fallbackReason: 'llm_not_ready',
          });
        }

        llm.configure({ generationConfig });

        const generationStartedAt = Date.now();
        const answer = await withTimeout(
          llm.generate(buildGeneralMessages(question) as Message[]),
          heavyAnswerTimeoutMs,
          '',
          llm.interrupt
        );
        const generationMs = Date.now() - generationStartedAt;
        const cleanAnswer = formatGeneralOutput(answer);

        return makeResponse({
          text: cleanAnswer || 'I could not prepare a clear answer yet. Please try asking in a simpler way.',
          answerMode: 'general',
          confidence: cleanAnswer ? 'medium' : 'low',
          generationMs,
          fallbackReason: cleanAnswer ? null : 'empty_general_answer',
        });
      }

      let queryEmbedding: Float32Array | null = null;
      const retrievalStartedAt = Date.now();

      if (embeddings.isReady) {
        queryEmbedding = await embeddings.forward(
          formatEmbeddingInput(question, 'query')
        );
      }

      const retrievalResult = await retrieveRelevantChunksWithMetadata(
        bookId,
        question,
        queryEmbedding,
        embeddingModelName
      );
      const retrievalMs = Date.now() - retrievalStartedAt;
      const chunks = retrievalResult.chunks;

      if (chunks.length === 0) {
        return makeResponse({
          text: 'The lesson does not have enough information about that yet.',
          answerMode: 'grounded',
          confidence: 'none',
          retrievalMs,
          fallbackReason: `no_relevant_${retrievalResult.fallbackKind}_chunks`,
        });
      }

      const sources = chunks.map(formatSourceLabel);

      if (llm.error) {
        return makeResponse({
          text: 'The study helper had trouble opening on this device. Please close other apps and try again.',
          sources,
          answerMode: 'status',
          confidence: retrievalResult.confidence,
          retrievalMs,
          topScore: retrievalResult.topScore,
          fallbackReason: 'llm_error',
        });
      }

      if (!shouldLoadLlm) {
        setShouldLoadLlm(true);
        return makeResponse({
          text: 'I found your lesson. The study helper is opening now, so please ask again in a moment.',
          sources,
          answerMode: 'status',
          confidence: retrievalResult.confidence,
          retrievalMs,
          topScore: retrievalResult.topScore,
          fallbackReason: 'llm_lazy_loading',
        });
      }

      if (!llm.isReady) {
        const progress = Math.round(llm.downloadProgress * 100);
        return makeResponse({
          text: `I found your lesson, but the study helper is still getting ready${progress > 0 ? ` (${progress}%)` : ''}.`,
          sources,
          answerMode: 'status',
          confidence: retrievalResult.confidence,
          retrievalMs,
          topScore: retrievalResult.topScore,
          fallbackReason: 'llm_not_ready',
        });
      }

      llm.configure({ generationConfig });

      const generationStartedAt = Date.now();
      const answer = await withTimeout(
        llm.generate(buildGroundedMessages(question, chunks) as Message[]),
        heavyAnswerTimeoutMs,
        '',
        llm.interrupt
      );
      const generationMs = Date.now() - generationStartedAt;

      const cleanAnswer = formatStudentOutput(answer);
      const fallbackReason = cleanAnswer && !isBadGroundedAnswer(cleanAnswer)
        ? null
        : 'quick_grounded_fallback';

      return makeResponse({
        text: cleanAnswer && !isBadGroundedAnswer(cleanAnswer)
          ? cleanAnswer
          : buildQuickGroundedAnswer(chunks),
        sources,
        answerMode: 'grounded',
        confidence: retrievalResult.confidence,
        retrievalMs,
        generationMs,
        topScore: retrievalResult.topScore,
        fallbackReason,
      });
    },
    [bookId, embeddings, hasCheckedDownload, llm, shouldLoadEmbeddings, shouldLoadLlm]
  );

  const generateStudyTool = useCallback(
    async (
      tool: 'quiz' | 'flashcards',
      mode: StudyToolMode = 'mcq',
      requestedCount?: number
    ): Promise<OfflineAiResponse> => {
      const startedAt = Date.now();
      const makeStudyResponse = async ({
        text,
        sources = [],
        confidence = 'none',
        retrievalMs,
        topScore = null,
        fallbackReason = null,
      }: {
        text: string;
        sources?: string[];
        confidence?: AiAnswerConfidence;
        retrievalMs?: number;
        topScore?: number | null;
        fallbackReason?: string | null;
      }): Promise<OfflineAiResponse> => {
        const metrics: OfflineAiMetrics = {
          retrievalMs,
          totalMs: Date.now() - startedAt,
          sourceCount: sources.length,
          topScore,
          fallbackReason,
        };

        try {
          await saveAiPerformanceMetric({
            bookId,
            answerMode: sources.length > 0 ? 'study_tool' : 'status',
            confidence,
            retrievalMs,
            totalMs: metrics.totalMs,
            sourceCount: sources.length,
            topScore,
            fallbackReason,
            outputLength: text.length,
            showedSources: sources.length > 0,
          });
        } catch {
          // The study tool remains useful even if metrics cannot be saved.
        }

        return {
          text,
          sources,
          answerMode: sources.length > 0 ? 'study_tool' : 'status',
          confidence,
          metrics,
        };
      };

      if (!hasCheckedDownload) {
        return makeStudyResponse({
          text: 'Checking your saved study helper...',
          fallbackReason: 'checking_download',
        });
      }

      if (!shouldLoadEmbeddings) {
        return makeStudyResponse({
          text: 'Please prepare the study helper from My Books first.',
          fallbackReason: 'model_not_prepared',
        });
      }

      const hasChunks = await hasReadyStudyChunks(bookId);

      if (!hasChunks) {
        return makeStudyResponse({
          text: 'ALAB needs a ready source before making this study tool.',
          fallbackReason: 'no_ready_chunks',
        });
      }

      const itemCount = getStudyToolItemCount(tool, requestedCount);
      const query =
        tool === 'quiz'
          ? `${itemCount} ${mode} quiz topics from ${bookTitle}`
          : `${itemCount} key terms and concepts from ${bookTitle}`;
      const retrievalStartedAt = Date.now();
      const queryEmbedding = embeddings.isReady
        ? await embeddings.forward(formatEmbeddingInput(query, 'query'))
        : null;
      const chunks = await retrieveStudyToolChunks(
        bookId,
        queryEmbedding,
        embeddingModelName,
        itemCount
      );
      const retrievalMs = Date.now() - retrievalStartedAt;

      if (chunks.length === 0) {
        return makeStudyResponse({
          text: 'ALAB needs a ready source before making this study tool.',
          retrievalMs,
          fallbackReason: 'no_study_tool_chunks',
        });
      }

      const toolText = buildSimpleStudyToolFallback(tool, chunks, mode, itemCount);

      try {
        await saveGeneratedStudyTool(
          tool,
          bookId,
          chunks.map((chunk) => chunk.id),
          toolText
        );
      } catch {
        // The generated message is still useful even if study-tool history fails.
      }

      return makeStudyResponse({
        text: toolText,
        sources: chunks.map(formatSourceLabel),
        confidence: 'medium',
        retrievalMs,
        topScore: chunks[0]?.score ?? null,
      });
    },
    [bookId, bookTitle, embeddings, hasCheckedDownload, shouldLoadEmbeddings]
  );

  const embedLessonText = useCallback(
    async (text: string): Promise<Float32Array | null> => {
      if (!shouldLoadEmbeddings || !embeddings.isReady) {
        return null;
      }

      return embeddings.forward(formatEmbeddingInput(text, 'passage'));
    },
    [embeddings, shouldLoadEmbeddings]
  );

  return {
    answerQuestion,
    generateStudyTool,
    embedLessonText,
    embeddingModelName,
    isAvailable,
    hasCheckedDownload,
    shouldLoadModel: shouldLoadEmbeddings,
    isModelReady: llm.isReady,
    isEmbeddingReady: embeddings.isReady,
    isGenerating: llm.isGenerating,
    llmDownloadProgress: llm.downloadProgress,
    embeddingDownloadProgress: embeddings.downloadProgress,
    error: llm.error ?? embeddings.error,
  };
}

function isBadGroundedAnswer(answer: string) {
  const normalized = answer.toLowerCase();

  return (
    normalized.includes('no pdf') ||
    normalized.includes('pdf included') ||
    normalized.includes('no document') ||
    normalized.includes('no file') ||
    normalized.includes('not provided')
  );
}

async function saveGeneratedStudyTool(
  tool: 'quiz' | 'flashcards',
  bookId: string,
  chunkIds: string[],
  text: string
) {
  try {
    if (tool === 'quiz') {
      await saveGeneratedQuiz(bookId, chunkIds, text);
      return;
    }

    await saveGeneratedFlashcards(bookId, chunkIds, text);
  } catch {
    // The generated message is still useful even if study-tool history fails.
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout?: () => void
): Promise<T> {
  return new Promise((resolve) => {
    let didTimeout = false;
    const timer = setTimeout(() => {
      didTimeout = true;
      onTimeout?.();
      resolve(fallback);
    }, timeoutMs);

    promise
      .then((value) => {
        if (!didTimeout) {
          resolve(value);
        }
      })
      .catch(() => {
        if (!didTimeout) {
          resolve(fallback);
        }
      })
      .finally(() => clearTimeout(timer));
  });
}

function buildQuickGroundedAnswer(chunks: { text: string }[]) {
  const snippets = uniqueTexts(
    chunks
      .flatMap((chunk) => splitReadableSentences(cleanChunkText(chunk.text)))
      .filter(isUsefulSentence)
  );
  const bestSnippet = snippets[0] ?? chunks
    .map((chunk) => cleanChunkText(chunk.text))
    .find(Boolean);

  if (!bestSnippet) {
    return 'I found a related part in your lesson, but I could not prepare a full answer yet. Please try asking in a simpler way.';
  }

  const support = snippets.find((snippet) => snippet !== bestSnippet);

  return formatStudentOutput([
    'I found this lesson idea:',
    '',
    shortText(bestSnippet, 190),
    support ? '' : null,
    support ? `A helpful detail is: ${shortText(support, 170)}` : null,
  ].filter(Boolean).join('\n'));
}

function isSummaryRequest(question: string) {
  const normalized = question.toLowerCase();

  return (
    normalized.includes('summarize') ||
    normalized.includes('summary') ||
    normalized.includes('sum up') ||
    normalized.includes('overview') ||
    normalized.includes('main idea') ||
    normalized.includes('what is this pdf about') ||
    normalized.includes('what is the pdf about')
  );
}

function getAnswerIntent(question: string, hasSources: boolean): AnswerIntent {
  if (isSummaryRequest(question)) {
    return 'summary';
  }

  if (isExplicitLessonRequest(question)) {
    return 'grounded';
  }

  if (isGeneralKnowledgeRequest(question)) {
    return 'general';
  }

  return hasSources ? 'grounded' : 'general';
}

function isExplicitLessonRequest(question: string) {
  const normalized = question.toLowerCase();

  return (
    /\b(this|the|my|our)\s+(lesson|book|pdf|source|module|chapter|material|textbook)\b/.test(normalized) ||
    /\bfrom\s+(the|this|my|our)?\s*(lesson|book|pdf|source|module|chapter|material|textbook)\b/.test(normalized) ||
    /\baccording to\s+(the|this|my|our)?\s*(lesson|book|pdf|source|module|chapter|material|textbook)\b/.test(normalized) ||
    normalized.includes('in the uploaded') ||
    normalized.includes('in your uploaded') ||
    normalized.includes('based on the lesson') ||
    normalized.includes('based on my lesson')
  );
}

function isGeneralKnowledgeRequest(question: string) {
  const normalized = question.toLowerCase();

  if (
    /\b(java|javascript|python|html|css|sql|c\+\+|c#|code|program|function|class|algorithm)\b/.test(normalized) ||
    /\b(write|create|make|give me|show me)\b.+\b(code|program|example|template|letter|essay|story|sentence|paragraph)\b/.test(normalized) ||
    /\btranslate\b|\bgrammar\b|\brewrite\b|\bproofread\b/.test(normalized)
  ) {
    return true;
  }

  return /^[\d\s+\-*/().=]+$/.test(normalized.trim());
}

function cleanChunkText(text: string) {
  return cleanLessonText(text).replace(/\s+/g, ' ').trim();
}

function splitSentences(chunks: { text: string }[]) {
  return chunks
    .flatMap((chunk) =>
      splitReadableSentences(cleanChunkText(chunk.text))
        .map((sentence) => sentence.trim())
    )
    .filter(isUsefulSentence);
}

function shortText(text: string, maxLength: number) {
  const cleanText = cleanChunkText(text);

  if (cleanText.length <= maxLength) {
    return cleanText;
  }

  return `${cleanText.slice(0, maxLength).replace(/\s+\S*$/, '')}...`;
}

function buildPdfSummary(chunks: { text: string }[]) {
  const sentences = splitSentences(chunks);
  const cleanSentences = uniqueTexts(sentences).slice(0, 7);
  const mainIdea = cleanSentences[0] ?? shortText(chunks[0]?.text ?? '', 180);
  const bullets = cleanSentences
    .slice(mainIdea ? 1 : 0, 7)
    .slice(0, 5)
    .map((sentence) => `- ${shortText(sentence, 170)}`);

  if (bullets.length === 0) {
    return formatStudentOutput([
      'Here is a quick summary of your lesson.',
      '',
      'Main idea',
      shortText(mainIdea, 190),
    ].join('\n'));
  }

  return formatStudentOutput([
    'Here is a quick summary of your lesson.',
    '',
    'Main idea',
    shortText(mainIdea, 190),
    '',
    'Important points',
    ...bullets,
    '',
    `Remember this: ${shortText(bullets[0].replace(/^-\s*/, ''), 150)}`,
  ].join('\n'));
}

function uniqueTexts(items: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const item of items) {
    const key = item.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function getKeyPhrase(sentence: string, fallbackIndex: number) {
  const words = sentence
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !noisyStudyWords.has(word.toLowerCase()))
    .slice(0, 5);

  if (words.length >= 2) {
    return words.slice(0, 3).join(' ');
  }

  return `lesson detail ${fallbackIndex + 1}`;
}

type LessonFact = {
  term: string;
  detail: string;
  sourceText: string;
};

function buildSimpleStudyToolFallback(
  tool: 'quiz' | 'flashcards',
  chunks: { text: string }[],
  mode: StudyToolMode = 'mcq',
  itemCount = tool === 'quiz' ? quizItemCount : flashcardItemCount
) {
  const facts = extractLessonFacts(chunks);
  const sentences = facts.length > 0
    ? facts.map((fact) => fact.sourceText)
    : uniqueTexts(splitSentences(chunks));
  const baseSnippets = sentences.length > 0
    ? sentences
    : chunks.map((chunk) => cleanChunkText(chunk.text)).filter(Boolean);
  const targetCount = getStudyToolItemCount(tool, itemCount);
  const repeatedFacts = repeatToCount(
    facts.length > 0 ? facts : buildFactsFromSnippets(baseSnippets),
    targetCount
  );

  if (tool === 'flashcards') {
    return repeatedFacts
      .map((fact) =>
        [
          `Front: ${fact.term}`,
          `Back: ${shortText(fact.detail.replace(/_____+/g, fact.term), 220)}`,
        ].join('\n')
      )
      .join('\n\n');
  }

  return repeatedFacts
    .map((fact, index) =>
      buildFallbackQuizQuestion(fact, repeatedFacts, index, mode)
    )
    .join('\n\n');
}

function getStudyToolItemCount(tool: 'quiz' | 'flashcards', requestedCount?: number) {
  const fallbackCount = tool === 'quiz' ? quizItemCount : flashcardItemCount;

  if (!requestedCount || !Number.isFinite(requestedCount)) {
    return fallbackCount;
  }

  return Math.max(1, Math.min(maxQuizItemCount, Math.round(requestedCount)));
}

function repeatToCount<T>(items: T[], count: number) {
  if (items.length === 0) {
    return [];
  }

  return Array.from({ length: count }, (_, index) => items[index % items.length]);
}

function extractLessonFacts(chunks: { text: string }[]): LessonFact[] {
  const facts = chunks
    .flatMap((chunk) => getLessonFactCandidates(chunk.text))
    .map(parseLessonFact)
    .filter((fact): fact is LessonFact => Boolean(fact));

  return uniqueFacts(facts);
}

function buildFactsFromSnippets(snippets: string[]): LessonFact[] {
  return uniqueTexts(snippets)
    .map((snippet, index) => ({
      term: titleCase(getKeyPhrase(snippet, index)),
      detail: shortText(snippet, 220),
      sourceText: snippet,
    }))
    .filter((fact) => isUsefulTerm(fact.term) && fact.detail.length > 20);
}

function parseLessonFact(sentence: string): LessonFact | null {
  const cleanSentence = cleanChunkText(sentence);

  if (!isUsefulSentence(cleanSentence) || isNoisyLessonText(cleanSentence)) {
    return null;
  }

  const patterns = [
    /^(.{2,70}?)(?:\s+-\s+|\s*[:\u2013\u2014]\s*)(.+)$/i,
    /^(.{2,70}?)\s+(is|are|means|refers to|describes|uses|is used for|is used to|are used for|are used to)\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = cleanSentence.match(pattern);

    if (!match) {
      continue;
    }

    const rawTerm = cleanStudyTerm(match[1]);
    const rawDetail = match.length >= 4
      ? `${match[2]} ${match[3]}`
      : match[2];
    const detail = cleanStudyDetail(rawDetail, rawTerm);

    if (isUsefulTerm(rawTerm) && isUsefulSentence(detail)) {
      return {
        term: rawTerm,
        detail,
        sourceText: cleanSentence,
      };
    }
  }

  return null;
}

function cleanStudyTerm(term: string) {
  return titleCase(
    cleanLessonText(term)
      .replace(/^\W+|\W+$/g, '')
      .replace(/^(the|a|an)\s+/i, '')
      .replace(/\s+/g, ' ')
    .trim()
  );
}

function cleanStudyDetail(detail: string, term: string) {
  return cleanLessonText(detail)
    .replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi'), '_____')
    .replace(/\s+/g, ' ')
    .replace(/^\W+/, '')
    .trim();
}

function isUsefulTerm(term: string) {
  const normalized = term.toLowerCase();

  return (
    term.length >= 3 &&
    term.length <= 70 &&
    !normalized.includes('question') &&
    !normalized.includes('answer') &&
    !normalized.includes('according') &&
    !normalized.includes('pdf') &&
    !normalized.includes('chapter') &&
    !normalized.includes('page') &&
    !normalized.includes('lesson detail') &&
    !genericStudyTerms.has(normalized) &&
    !/^\d+$/.test(normalized)
  );
}

function uniqueFacts(facts: LessonFact[]) {
  const seen = new Set<string>();
  const unique: LessonFact[] = [];

  for (const fact of facts) {
    const key = normalizeOption(fact.term);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(fact);
  }

  return unique;
}

function buildFallbackQuizQuestion(
  fact: LessonFact,
  allFacts: LessonFact[],
  index: number,
  mode: StudyToolMode
) {
  if (mode === 'fill_blank') {
    return [
      `Question: ${buildFillBlankQuestion(fact)}`,
      `Answer: ${fact.term}`,
      `Explanation: ${shortText(fact.detail.replace(/_____+/g, fact.term), 170)}`,
    ].join('\n');
  }

  if (mode === 'essay') {
    return [
      `Question: Explain ${fact.term} in your own words.`,
      `Answer: ${shortText(fact.detail.replace(/_____+/g, fact.term), 210)}`,
      `Explanation: Include the lesson idea and one clear example.`,
    ].join('\n');
  }

  const options = buildUniqueOptions(fact, allFacts, index);
  const correctIndex = options.findIndex((option) => option === fact.term);
  const answerLetter = String.fromCharCode(65 + Math.max(0, correctIndex));

  return [
    `Question: ${buildDefinitionQuestion(fact)}`,
    `A. ${options[0]}`,
    `B. ${options[1]}`,
    `C. ${options[2]}`,
    `D. ${options[3]}`,
    `Correct answer: ${answerLetter}. ${fact.term}`,
    `Explanation: ${shortText(fact.detail.replace(/_____+/g, fact.term), 170)}`,
  ].join('\n');
}

function buildDefinitionQuestion(fact: LessonFact) {
  const detail = fact.detail.replace(/_____+/g, 'it');
  const prompt = detail.charAt(0).toUpperCase() + detail.slice(1);

  return `Which term best matches this lesson idea: ${shortText(prompt, 130)}?`;
}

function buildFillBlankQuestion(fact: LessonFact) {
  if (fact.detail.includes('_____')) {
    return shortText(fact.detail, 150);
  }

  return `_____ means ${shortText(fact.detail, 135)}`;
}

function buildUniqueOptions(
  fact: LessonFact,
  allFacts: LessonFact[],
  index: number
) {
  const distractors = [
    ...allFacts.map((item) => item.term),
    'Software',
    'Digital Tool',
    'Hardware',
    'Application',
    'System',
    'Data',
  ].filter((term) => normalizeOption(term) !== normalizeOption(fact.term));
  const uniqueDistractors = uniqueByNormalized(distractors).slice(0, 12);
  const selectedDistractors = rotateItems(uniqueDistractors, index).slice(0, 3);
  const paddedOptions = uniqueByNormalized([
    fact.term,
    ...selectedDistractors,
    'Software',
    'Digital Tool',
    'Hardware',
    'Data',
    'Application',
    'Computer Program',
  ]).slice(0, 4);

  return rotateItems(paddedOptions, index).slice(0, 4);
}

function rotateItems<T>(items: T[], offset: number) {
  if (items.length === 0) {
    return items;
  }

  const start = offset % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function uniqueByNormalized(items: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const item of items) {
    const cleanItem = cleanStudyTerm(item);
    const key = normalizeOption(cleanItem);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(cleanItem);
  }

  return unique;
}

function normalizeOption(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word.length <= 3 && word === word.toUpperCase()
        ? word
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`
    )
    .join(' ');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const noisyStudyWords = new Set([
  'chapter',
  'lesson',
  'module',
  'page',
  'pages',
  'pdf',
  'uploaded',
  'source',
  'textbook',
]);

const genericStudyTerms = new Set([
  'activity',
  'application',
  'chapter',
  'definition',
  'digital tool',
  'example',
  'hardware',
  'lesson',
  'module',
  'page',
  'paragraph',
  'question',
  'section',
  'software',
  'system',
  'topic',
]);

function getLessonFactCandidates(text: string) {
  const cleanText = cleanLessonText(text);
  const lineCandidates = cleanText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return uniqueTexts([
    ...lineCandidates,
    ...splitReadableSentences(cleanText),
  ]).filter((candidate) => !isNoisyLessonText(candidate));
}

function isUsefulSentence(sentence: string) {
  const cleanSentence = cleanLessonText(sentence);
  const words = cleanSentence.split(/\s+/).filter(Boolean);

  return (
    cleanSentence.length >= 24 &&
    cleanSentence.length <= 260 &&
    words.length >= 4 &&
    !isNoisyLessonText(cleanSentence)
  );
}

function isNoisyLessonText(text: string) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const chapterMentions = normalized.match(/\bchapter\s+\d+\b/g)?.length ?? 0;

  return (
    !normalized ||
    /^page \d+$/.test(normalized) ||
    /^chapter \d*/.test(normalized) ||
    /^module \d*/.test(normalized) ||
    chapterMentions >= 2 ||
    /\bchapter\s+\d+\s+.+\bchapter\s+\d+\b/i.test(text) ||
    /^[-|_\s]+$/.test(text) ||
    normalized.includes('table of contents') ||
    normalized.includes('according to the pdf') ||
    normalized.includes('uploaded pdf')
  );
}
