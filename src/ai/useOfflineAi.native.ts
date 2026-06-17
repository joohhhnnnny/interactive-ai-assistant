import { useCallback, useEffect, useState } from 'react';
import {
  isAvailable,
  Message,
  useLLM,
  useTextEmbeddings,
} from 'react-native-executorch';
import type { AiAnswerConfidence, AiAnswerMode } from '../data/database';
import {
  getAppSetting,
  hasReadySources,
  hasReadyStudyChunks,
  saveAiPerformanceMetric,
  saveGeneratedFlashcards,
  saveGeneratedQuiz,
} from '../data/database';
import {
  embeddingModelName,
  formatEmbeddingInput,
  modelDownloadedKey,
  modelProfileKey,
  offlineEmbeddingModel,
  offlineLlmModel,
  offlineModelProfile,
  offlineSearchModelProfile,
  searchModelDownloadedKey,
  searchModelProfileKey,
} from './offlineModelResources.native';
import {
  buildGeneralMessages,
  buildGroundedMessages,
  formatSourceLabel,
  retrieveBookOverviewChunks,
  retrieveRelevantChunksWithMetadata,
  retrieveStudyToolChunks,
} from './retrieval';
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
  const [hasAnswerHelperPrepared, setHasAnswerHelperPrepared] = useState(false);
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
      getAppSetting(searchModelDownloadedKey),
      getAppSetting(searchModelProfileKey),
    ])
      .then(([
        downloadedValue,
        profileValue,
        searchDownloadedValue,
        searchProfileValue,
      ]) => {
        const hasFullStudyHelper =
          downloadedValue === 'true' && profileValue === offlineModelProfile;
        const hasSearchHelper =
          searchDownloadedValue === 'true' &&
          searchProfileValue === offlineSearchModelProfile;

        if (isActive && (hasFullStudyHelper || hasSearchHelper)) {
          setShouldLoadEmbeddings(true);
        }

        if (isActive && hasFullStudyHelper) {
          setHasAnswerHelperPrepared(true);
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

      const hasSources = await hasReadySources(bookId);
      const intent = getAnswerIntent(question, hasSources);

      if (!shouldLoadEmbeddings && intent === 'general') {
        return makeResponse({
          text: 'Please prepare the study helper from My Books first.',
          answerMode: 'status',
          fallbackReason: 'model_not_prepared',
        });
      }

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
        if (!hasAnswerHelperPrepared) {
          return makeResponse({
            text: 'Please finish preparing the study helper from My Books first.',
            answerMode: 'status',
            fallbackReason: 'answer_helper_not_prepared',
          });
        }

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

      if (shouldLoadEmbeddings && embeddings.isReady) {
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

      if (!hasAnswerHelperPrepared) {
        return makeResponse({
          text: buildQuickGroundedAnswer(chunks),
          sources,
          answerMode: 'grounded',
          confidence: retrievalResult.confidence,
          retrievalMs,
          topScore: retrievalResult.topScore,
          fallbackReason: 'answer_helper_not_prepared',
        });
      }

      if (llm.error) {
        return makeResponse({
          text: buildQuickGroundedAnswer(chunks),
          sources,
          answerMode: 'grounded',
          confidence: retrievalResult.confidence,
          retrievalMs,
          topScore: retrievalResult.topScore,
          fallbackReason: 'quick_grounded_llm_error',
        });
      }

      if (!shouldLoadLlm) {
        setShouldLoadLlm(true);
        return makeResponse({
          text: buildQuickGroundedAnswer(chunks),
          sources,
          answerMode: 'grounded',
          confidence: retrievalResult.confidence,
          retrievalMs,
          topScore: retrievalResult.topScore,
          fallbackReason: 'quick_grounded_llm_lazy_loading',
        });
      }

      if (!llm.isReady) {
        return makeResponse({
          text: buildQuickGroundedAnswer(chunks),
          sources,
          answerMode: 'grounded',
          confidence: retrievalResult.confidence,
          retrievalMs,
          topScore: retrievalResult.topScore,
          fallbackReason: 'quick_grounded_llm_not_ready',
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
    [
      bookId,
      embeddings,
      hasAnswerHelperPrepared,
      hasCheckedDownload,
      llm,
      shouldLoadEmbeddings,
      shouldLoadLlm,
    ]
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
          text: `Checking your saved study helper before making ${tool === 'quiz' ? 'this quiz' : 'these flashcards'}...`,
          fallbackReason: 'checking_download',
        });
      }

      const hasChunks = await hasReadyStudyChunks(bookId);

      if (!hasChunks) {
        return makeStudyResponse({
          text: `ALAB is still preparing your lesson. Please wait until the source says Ready to study, then ask for ${tool === 'quiz' ? 'the quiz' : 'flashcards'} again.`,
          fallbackReason: 'no_ready_chunks',
        });
      }

      const itemCount = getStudyToolItemCount(tool, requestedCount);
      const query =
        tool === 'quiz'
          ? `${itemCount} ${mode} quiz topics from ${bookTitle}`
          : `${itemCount} key terms and concepts from ${bookTitle}`;
      const retrievalStartedAt = Date.now();
      const queryEmbedding = shouldLoadEmbeddings && embeddings.isReady
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
          text: `ALAB is still preparing your lesson. Please wait until the source says Ready to study, then ask for ${tool === 'quiz' ? 'the quiz' : 'flashcards'} again.`,
          retrievalMs,
          fallbackReason: 'no_study_tool_chunks',
        });
      }

      const toolText = buildSimpleStudyToolFallback(tool, chunks, mode, itemCount);

      if (tool === 'quiz' && mode === 'mcq' && !hasValidMcqQuiz(toolText)) {
        return makeStudyResponse({
          text: 'ALAB needs a little more readable lesson text before making a multiple-choice quiz. Please try again after the source finishes analyzing.',
          retrievalMs,
          topScore: chunks[0]?.score ?? null,
          fallbackReason: 'invalid_mcq_quiz',
        });
      }

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
      if (!shouldLoadEmbeddings || !embeddings.isReady || embeddings.error) {
        return null;
      }

      try {
        return await embeddings.forward(formatEmbeddingInput(text, 'passage'));
      } catch {
        return null;
      }
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

function hasValidMcqQuiz(text: string) {
  return text
    .split(/(?=Question\s*\d*\s*[:.)-])/i)
    .map((block) => block.trim())
    .filter((block) => /^question\s*\d*\s*[:.)-]/i.test(block))
    .some(hasValidMcqBlock);
}

function hasValidMcqBlock(block: string) {
  const lines = block
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const options = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const optionMatch = line.match(/^([A-D])[.)]\s*(.*)$/i);

    if (!optionMatch) {
      continue;
    }

    const letter = optionMatch[1].toUpperCase();
    const inlineText = optionMatch[2].trim();
    const optionText = inlineText || lines[index + 1]?.trim() || '';

    if (optionText) {
      options.set(letter, optionText);
    }
  }

  const answerMatch = block.match(
    /(?:^|\n)Correct\s*answer\s*:\s*([A-D])[.)]?(?:\s+|\n)?([^\n]*)/i
  );

  if (options.size < 4 || !answerMatch) {
    return false;
  }

  const answerLetter = answerMatch[1].toUpperCase();
  const correctOption = options.get(answerLetter);
  const answerText = answerMatch[2]?.trim() ?? '';

  if (!correctOption) {
    return false;
  }

  return (
    !answerText ||
    normalizeAnswerText(answerText) === normalizeAnswerText(correctOption) ||
    normalizeAnswerText(answerText).includes(normalizeAnswerText(correctOption))
  );
}

function normalizeAnswerText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

type LessonFact = {
  term: string;
  detail: string;
  sourceText: string;
  kind?: 'term' | 'statement';
};

function buildSimpleStudyToolFallback(
  tool: 'quiz' | 'flashcards',
  chunks: { text: string }[],
  mode: StudyToolMode = 'mcq',
  itemCount = tool === 'quiz' ? quizItemCount : flashcardItemCount
) {
  const facts = extractLessonFacts(chunks);
  const sentences = uniqueTexts(splitSentences(chunks));
  const baseSnippets = sentences.length > 0
    ? sentences
    : chunks.map((chunk) => cleanChunkText(chunk.text)).filter(Boolean);
  const targetCount = getStudyToolItemCount(tool, itemCount);
  const snippetFacts = buildFactsFromSnippets(baseSnippets);
  const emergencyFacts = buildEmergencyFactsFromChunks(chunks);
  const studyFacts = uniqueFacts([
    ...facts,
    ...snippetFacts,
    ...emergencyFacts,
  ]);
  const selectedFacts = tool === 'quiz'
    ? buildQuizFacts(studyFacts, baseSnippets, targetCount)
    : repeatToCount(studyFacts, targetCount);

  if (selectedFacts.length === 0) {
    return tool === 'quiz'
      ? 'ALAB needs clearer lesson definitions before making a quiz.'
      : 'ALAB needs clearer lesson definitions before making flashcards.';
  }

  if (tool === 'flashcards') {
    return selectedFacts
      .map((fact) =>
        [
          `Front: ${fact.term}`,
          `Back: ${shortText(fact.detail.replace(/_____+/g, fact.term), 220)}`,
        ].join('\n')
      )
      .join('\n\n');
  }

  return selectedFacts
    .map((fact, index) =>
      buildFallbackQuizQuestion(fact, selectedFacts, index, mode)
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
  const definitionFacts = uniqueTexts(snippets)
    .map(parseLessonFactFromDefinition)
    .filter((fact): fact is LessonFact => Boolean(fact));

  if (definitionFacts.length > 0) {
    return definitionFacts;
  }

  return uniqueTexts(snippets)
    .filter(isUsefulSentence)
    .slice(0, maxQuizItemCount)
    .map((snippet) => ({
      term: shortText(snippet, 130),
      detail: 'This statement is true based on the lesson.',
      sourceText: snippet,
      kind: 'statement' as const,
    }));
}

function buildEmergencyFactsFromChunks(chunks: { text: string }[]): LessonFact[] {
  return uniqueTexts(
    chunks
      .map((chunk) => cleanChunkText(chunk.text))
      .flatMap((text) => text.split(/(?<=[.!?])\s+|\n+/))
      .map((text) => shortText(text, 160))
      .filter(isUsefulEmergencyFactText)
  )
    .slice(0, maxQuizItemCount)
    .map((snippet) => ({
      term: snippet,
      detail: 'This statement is true based on the lesson.',
      sourceText: snippet,
      kind: 'statement' as const,
    }));
}

function isUsefulEmergencyFactText(text: string) {
  const cleanText = cleanLessonText(text);
  const words = cleanText.split(/\s+/).filter(Boolean);

  return (
    cleanText.length >= 28 &&
    cleanText.length <= 180 &&
    words.length >= 5 &&
    !isNoisyLessonText(cleanText)
  );
}

function buildQuizFacts(
  facts: LessonFact[],
  snippets: string[],
  targetCount: number
) {
  const selectedFacts = uniqueFacts(facts).slice(0, targetCount);

  if (selectedFacts.length >= targetCount) {
    return selectedFacts;
  }

  const extraFacts = uniqueFacts([
    ...selectedFacts,
    ...buildFactsFromSnippets(snippets),
  ]).slice(0, targetCount);

  if (extraFacts.length >= targetCount) {
    return extraFacts;
  }

  return repeatToCount(extraFacts, targetCount);
}

function parseLessonFact(sentence: string): LessonFact | null {
  const cleanSentence = cleanChunkText(sentence);

  if (!isUsefulSentence(cleanSentence) || isNoisyLessonText(cleanSentence)) {
    return null;
  }

  const definitionFact = parseLessonFactFromDefinition(cleanSentence);

  if (definitionFact) {
    return definitionFact;
  }

  const patterns = [
    /^(.{2,70}?)(?:\s+-\s+|\s*[:\u2013\u2014]\s*)(.+)$/i,
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
        kind: 'term',
      };
    }
  }

  return null;
}

function parseLessonFactFromDefinition(sentence: string): LessonFact | null {
  const cleanSentence = cleanChunkText(sentence);
  const calledMatch = cleanSentence.match(
    /^(.{12,170}?)\s+(?:is|are)\s+called\s+(?:a|an|the)?\s*([A-Za-z][A-Za-z0-9 /()+#.-]{1,35})\.?$/i
  );

  if (calledMatch) {
    const rawTerm = cleanStudyTerm(calledMatch[2]);
    const detail = cleanStudyDetail(`${calledMatch[1]} is called ${rawTerm}`, rawTerm);

    if (
      isUsefulTerm(rawTerm) &&
      isUsefulSentence(detail) &&
      isAnswerableFact(rawTerm, detail)
    ) {
      return {
        term: rawTerm,
        detail,
        sourceText: cleanSentence,
        kind: 'term',
      };
    }
  }

  const definitionPatterns = [
    /\b([A-Z][A-Za-z0-9 /()+#.-]{2,45})\s+(is|are|means|refers to|describes|uses|is used for|is used to|are used for|are used to)\s+(.+)$/i,
    /\b([A-Z][A-Za-z0-9 /()+#.-]{2,45})(?:\s+-\s+|\s*[:\u2013\u2014]\s+)(.+)$/i,
  ];

  for (const pattern of definitionPatterns) {
    const match = cleanSentence.match(pattern);

    if (!match) {
      continue;
    }

    const rawTerm = cleanStudyTerm(match[1]);
    const rawDetail = match.length >= 4 ? `${match[2]} ${match[3]}` : match[2];
    const detail = cleanStudyDetail(rawDetail, rawTerm);

    if (
      isUsefulTerm(rawTerm) &&
      isUsefulSentence(detail) &&
      isAnswerableFact(rawTerm, detail)
    ) {
      return {
        term: rawTerm,
        detail,
        sourceText: cleanSentence,
        kind: 'term',
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
    term.length <= 45 &&
    !term.includes(',') &&
    !term.includes('?') &&
    !/\b(is|are|means|refers|called|enough|erased|first|level|pages|designed|absolute|beginner|everywhere|today)\b/i.test(term) &&
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

function isAnswerableFact(term: string, detail: string) {
  const normalizedTerm = normalizeOption(term);
  const normalizedDetail = normalizeOption(detail);

  return (
    normalizedTerm.length > 0 &&
    normalizedDetail.length >= 20 &&
    !normalizedDetail.includes(normalizedTerm) &&
    !normalizedDetail.includes('no prior knowledge') &&
    !normalizedDetail.includes('beginner pages') &&
    !normalizedDetail.includes('first edition') &&
    !normalizedDetail.includes('ready to study') &&
    !normalizedDetail.startsWith('this ') &&
    !normalizedDetail.startsWith('it ') &&
    normalizedDetail.split(/\s+/).length >= 4
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

  if (fact.kind === 'statement') {
    return buildStatementQuizQuestion(fact, allFacts, index);
  }

  const options = buildUniqueOptions(fact, allFacts, index);
  const correctIndex = options.findIndex(
    (option) => normalizeOption(option) === normalizeOption(fact.term)
  );
  const answerLetter = String.fromCharCode(65 + Math.max(0, correctIndex));
  const correctOption = options[Math.max(0, correctIndex)] ?? fact.term;

  return [
    `Question: ${buildDefinitionQuestion(fact)}`,
    `A. ${options[0]}`,
    `B. ${options[1]}`,
    `C. ${options[2]}`,
    `D. ${options[3]}`,
    `Correct answer: ${answerLetter}. ${correctOption}`,
    `Explanation: ${shortText(fact.detail.replace(/_____+/g, fact.term), 170)}`,
  ].join('\n');
}

function buildStatementQuizQuestion(
  fact: LessonFact,
  allFacts: LessonFact[],
  index: number
) {
  const options = buildStatementOptions(fact, allFacts, index);
  const correctIndex = options.findIndex(
    (option) => normalizeOption(option) === normalizeOption(fact.term)
  );
  const answerLetter = String.fromCharCode(65 + Math.max(0, correctIndex));
  const correctOption = options[Math.max(0, correctIndex)] ?? fact.term;

  return [
    'Question: Which statement is true based on the lesson?',
    `A. ${options[0]}`,
    `B. ${options[1]}`,
    `C. ${options[2]}`,
    `D. ${options[3]}`,
    `Correct answer: ${answerLetter}. ${correctOption}`,
    `Explanation: ${shortText(correctOption, 170)}`,
  ].join('\n');
}

function buildDefinitionQuestion(fact: LessonFact) {
  const detail = fact.detail.replace(/_____+/g, 'this idea');
  const prompt = detail.charAt(0).toUpperCase() + detail.slice(1);

  return `Which word matches this meaning: ${shortText(prompt, 130)}?`;
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
  ].filter((term) => normalizeOption(term) !== normalizeOption(fact.term));
  const uniqueDistractors = uniqueByNormalized(distractors).slice(0, 12);
  const selectedDistractors = rotateItems(uniqueDistractors, index).slice(0, 3);
  const fallbackDistractors = getFallbackDistractors(fact.term);
  const paddedOptions = uniqueByNormalized([
    fact.term,
    ...selectedDistractors,
    ...fallbackDistractors,
  ]).slice(0, 4);

  return rotateItems(paddedOptions, index).slice(0, 4);
}

function buildStatementOptions(
  fact: LessonFact,
  allFacts: LessonFact[],
  index: number
) {
  const distractors = allFacts
    .map((item) => item.term)
    .filter((term) => normalizeOption(term) !== normalizeOption(fact.term));
  const fallbackDistractors = [
    'The lesson says computers cannot process data.',
    'The lesson says storage is only temporary.',
    'The lesson says software is the physical part of a computer.',
    'The lesson says a byte is smaller than a bit.',
    'The lesson says input is the final result from a computer.',
  ];
  const options = uniqueByNormalized([
    fact.term,
    ...rotateItems(distractors, index).slice(0, 3),
    ...fallbackDistractors,
  ]).slice(0, 4);

  return rotateItems(options, index).slice(0, 4);
}

function getFallbackDistractors(correctTerm: string) {
  const normalizedTerm = normalizeOption(correctTerm);
  const computingTerms = [
    'Computer',
    'Hardware',
    'Software',
    'RAM',
    'Storage',
    'Byte',
    'Bit',
    'Input',
    'Output',
    'Data',
    'Application',
    'Operating System',
  ];

  return computingTerms.filter((term) => normalizeOption(term) !== normalizedTerm);
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

const genericStudyTerms = new Set([
  'activity',
  'application',
  'chapter',
  'definition',
  'digital tool',
  'edition',
  'example',
  'hardware',
  'lesson',
  'module',
  'page',
  'paragraph',
  'question',
  'section',
  'software',
  'software hardware',
  'system',
  'this',
  'topic',
]);

function getLessonFactCandidates(text: string) {
  const cleanText = cleanLessonText(text);
  const lineCandidates = cleanText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      line.length <= 180 &&
      /(?:\s+-\s+|[:\u2013\u2014]|\b(?:is|are|means|refers to|is used for|is used to|called)\b)/i.test(line)
    );

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
    normalized.includes('first edition') ||
    normalized.includes('level beginner') ||
    normalized.includes('no prior knowledge') ||
    normalized.includes('designed for absolute beginners') ||
    normalized.includes('computers are everywhere today') ||
    normalized.includes('according to the pdf') ||
    normalized.includes('uploaded pdf')
  );
}
