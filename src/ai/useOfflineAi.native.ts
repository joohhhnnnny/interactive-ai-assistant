import { useCallback, useEffect, useRef, useState } from 'react';
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
  buildPdfSummary,
  buildQuickGroundedAnswer,
  getAnswerIntent,
  isBadGroundedAnswer,
} from './rag/agent/answers';
import type { StudyToolMode } from './rag/agent/studyTools';
import {
  buildSimpleStudyToolFallback,
  countFlashcards,
  getStudyToolItemCount,
  hasValidMcqQuiz,
} from './rag/agent/studyTools';
import {
  buildGeneralMessages,
  buildGroundedMessages,
  formatSourceLabel,
  retrieveRelevantChunksWithMetadata,
  retrieveSummaryChunks,
  retrieveStudyToolChunks,
} from './retrieval';
import { formatGeneralOutput } from './textCleanup';

type OfflineAiResponse = {
  text: string;
  sources: string[];
  answerMode: AiAnswerMode;
  confidence?: AiAnswerConfidence;
  metrics?: OfflineAiMetrics;
};

type OfflineAiMetrics = {
  retrievalMs?: number;
  generationMs?: number;
  totalMs?: number;
  sourceCount?: number;
  topScore?: number | null;
  fallbackReason?: string | null;
};

const heavyAnswerTimeoutMs = 30000;
const answerHelperWarmupTimeoutMs = 12000;
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
  const llmReadyRef = useRef(false);
  const llmErrorRef = useRef<unknown>(null);
  const llmGeneratingRef = useRef(false);
  const activeGenerationPromiseRef = useRef<Promise<string> | null>(null);
  const generationCancelledRef = useRef(false);
  const shouldLoadLlmRef = useRef(false);
  const llm = useLLM({
    model: offlineLlmModel,
    preventLoad: !shouldLoadLlm,
  });
  const embeddings = useTextEmbeddings({
    model: offlineEmbeddingModel,
    preventLoad: !shouldLoadEmbeddings,
  });

  useEffect(() => {
    llmReadyRef.current = llm.isReady;
    llmErrorRef.current = llm.error ?? null;
    llmGeneratingRef.current = llm.isGenerating;
  }, [llm.error, llm.isGenerating, llm.isReady]);

  useEffect(() => {
    shouldLoadLlmRef.current = shouldLoadLlm;
  }, [shouldLoadLlm]);

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
          setShouldLoadLlm(true);
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

  const waitForAnswerHelperReady = useCallback(async () => {
    if (!hasAnswerHelperPrepared) {
      return false;
    }

    if (llmReadyRef.current) {
      return true;
    }

    if (llmErrorRef.current) {
      return false;
    }

    if (!shouldLoadLlmRef.current) {
      shouldLoadLlmRef.current = true;
      setShouldLoadLlm(true);
    }

    const startedAt = Date.now();

    while (Date.now() - startedAt < answerHelperWarmupTimeoutMs) {
      if (llmReadyRef.current) {
        return true;
      }

      if (llmErrorRef.current) {
        return false;
      }

      await delay(200);
    }

    return false;
  }, [hasAnswerHelperPrepared]);

  const interruptLlm = useCallback(() => {
    try {
      llm.interrupt();
    } catch {
      // The model may already be unloading or not fully loaded.
    }
  }, [llm]);

  const generateLlmText = useCallback(
    (messages: Message[], timeoutMs: number) => {
      const generationPromise = llm.generate(messages);

      activeGenerationPromiseRef.current = generationPromise;
      llmGeneratingRef.current = true;

      generationPromise.then(
        () => {
          if (activeGenerationPromiseRef.current === generationPromise) {
            activeGenerationPromiseRef.current = null;
            llmGeneratingRef.current = false;
          }
        },
        () => {
          if (activeGenerationPromiseRef.current === generationPromise) {
            activeGenerationPromiseRef.current = null;
            llmGeneratingRef.current = false;
          }
        }
      );

      return withTimeout(
        generationPromise,
        timeoutMs,
        '',
        interruptLlm
      );
    },
    [interruptLlm, llm]
  );

  const answerQuestion = useCallback(
    async (
      question: string,
      conversationContext?: string
    ): Promise<OfflineAiResponse> => {
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

      const answerGeneralQuestion = async (
        fallbackReasonPrefix = 'general'
      ): Promise<OfflineAiResponse> => {
        if (!hasAnswerHelperPrepared) {
          return makeResponse({
            text: 'Please finish preparing the study helper from My Books first.',
            answerMode: 'status',
            fallbackReason: 'answer_helper_not_prepared',
          });
        }

        if (llmErrorRef.current) {
          return makeResponse({
            text: 'The study helper had trouble opening on this device. Please close other apps and try again.',
            answerMode: 'status',
            fallbackReason: `${fallbackReasonPrefix}_llm_error`,
          });
        }

        const isAnswerHelperReady = await waitForAnswerHelperReady();

        if (!isAnswerHelperReady) {
          return makeResponse({
            text: 'ALAB is still opening the study helper. Please try again in a moment.',
            answerMode: 'status',
            fallbackReason: `${fallbackReasonPrefix}_llm_warmup_timeout`,
          });
        }

        llm.configure({ generationConfig });

        const generationStartedAt = Date.now();
        const answer = await generateLlmText(
          buildGeneralMessages(question, conversationContext) as Message[],
          heavyAnswerTimeoutMs
        );
        const generationMs = Date.now() - generationStartedAt;
        const cleanAnswer = formatGeneralOutput(answer);

        return makeResponse({
          text: cleanAnswer ||
            'ALAB could not generate a reliable answer this time. Please try again in a moment.',
          answerMode: cleanAnswer ? 'general' : 'status',
          confidence: cleanAnswer ? 'medium' : 'none',
          generationMs,
          fallbackReason: cleanAnswer ? null : `${fallbackReasonPrefix}_empty_general_answer`,
        });
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
      const isExplicitLessonQuestion =
        getAnswerIntent(question, false) === 'grounded';

      if (!shouldLoadEmbeddings && intent === 'general') {
        return answerGeneralQuestion('model_not_prepared_general');
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
        const summaryQuery = buildSummaryRetrievalQuery(question, conversationContext);
        const summaryEmbedding = shouldLoadEmbeddings && embeddings.isReady
          ? await embeddings.forward(formatEmbeddingInput(summaryQuery, 'query'))
          : null;
        const chunks = await retrieveSummaryChunks(
          bookId,
          question,
          conversationContext,
          summaryEmbedding,
          embeddingModelName,
          12
        );
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

        if (!hasAnswerHelperPrepared) {
          return makeResponse({
            text: 'I found readable lesson text to summarize, but the full study helper needs to be prepared before ALAB can explain it naturally. Please finish preparing the study helper from My Books first.',
            answerMode: 'status',
            retrievalMs,
            topScore: chunks[0]?.score ?? null,
            fallbackReason: 'summary_answer_helper_not_prepared',
          });
        }

        if (llmErrorRef.current) {
          return makeResponse({
            text: 'I found readable lesson text to summarize, but the study helper had trouble opening on this device. Please close other apps and try again.',
            answerMode: 'status',
            retrievalMs,
            topScore: chunks[0]?.score ?? null,
            fallbackReason: 'summary_llm_error',
          });
        }

        const isAnswerHelperReady = llm.isReady || await waitForAnswerHelperReady();

        if (!isAnswerHelperReady) {
          return makeResponse({
            text: 'I found readable lesson text, but ALAB is still opening the study helper so it can summarize it properly. Please ask again in a moment.',
            answerMode: 'status',
            retrievalMs,
            topScore: chunks[0]?.score ?? null,
            fallbackReason: 'summary_llm_warmup_timeout',
          });
        }

        llm.configure({ generationConfig });

        const generationStartedAt = Date.now();
        const answer = await generateLlmText(
          buildGroundedMessages(
            `Summarize this lesson part for the student.\nStudent request: ${question}`,
            chunks,
            conversationContext
          ) as Message[],
          heavyAnswerTimeoutMs
        );
        const generationMs = Date.now() - generationStartedAt;
        const cleanAnswer = formatGeneralOutput(answer);

        if (!cleanAnswer || isBadGroundedAnswer(cleanAnswer)) {
          const fallbackSummary =
            buildPdfSummary(chunks) ||
            buildQuickGroundedAnswer(chunks);

          return makeResponse({
            text: fallbackSummary ||
              'I found readable lesson text, but it is too fragmented for a complete summary. Ask about one topic, section, or keyword from the lesson and I will focus on that part.',
            sources,
            answerMode: fallbackSummary ? 'summary' : 'status',
            confidence: fallbackSummary ? 'low' : 'none',
            retrievalMs,
            generationMs,
            topScore: chunks[0]?.score ?? null,
            fallbackReason: 'summary_llm_invalid_answer',
          });
        }

        return makeResponse({
          text: cleanAnswer,
          sources,
          answerMode: 'summary',
          confidence: 'medium',
          retrievalMs,
          generationMs,
          topScore: chunks[0]?.score ?? null,
        });
      }

      if (intent === 'general') {
        return answerGeneralQuestion();
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
        if (!isExplicitLessonQuestion) {
          return answerGeneralQuestion('no_retrieval_general');
        }

        return makeResponse({
          text: 'The lesson does not have enough information about that yet.',
          answerMode: 'grounded',
          confidence: 'none',
          retrievalMs,
          fallbackReason: `no_relevant_${retrievalResult.fallbackKind}_chunks`,
        });
      }

      const sources = chunks.map(formatSourceLabel);

      if (
        retrievalResult.confidence === 'low' &&
        !isExplicitLessonQuestion
      ) {
        return answerGeneralQuestion('low_retrieval_general');
      }

      if (!hasAnswerHelperPrepared) {
        return makeResponse({
          text: 'I found relevant lesson text, but the full study helper needs to be prepared before ALAB can explain it naturally. Please finish preparing the study helper from My Books first.',
          answerMode: 'status',
          retrievalMs,
          topScore: retrievalResult.topScore,
          fallbackReason: 'grounded_answer_helper_not_prepared',
        });
      }

      if (llmErrorRef.current) {
        return makeResponse({
          text: 'I found relevant lesson text, but the study helper had trouble opening on this device. Please close other apps and try again.',
          answerMode: 'status',
          retrievalMs,
          topScore: retrievalResult.topScore,
          fallbackReason: 'grounded_llm_error',
        });
      }

      const isAnswerHelperReady = llm.isReady || await waitForAnswerHelperReady();

      if (!isAnswerHelperReady) {
        return makeResponse({
          text: 'I found relevant lesson text, but ALAB is still opening the study helper so it can explain the answer properly. Please ask again in a moment.',
          answerMode: 'status',
          retrievalMs,
          topScore: retrievalResult.topScore,
          fallbackReason: 'grounded_llm_warmup_timeout',
        });
      }

      llm.configure({ generationConfig });

      const generationStartedAt = Date.now();
      const answer = await generateLlmText(
        buildGroundedMessages(
          question,
          chunks,
          conversationContext
        ) as Message[],
        heavyAnswerTimeoutMs
      );
      const generationMs = Date.now() - generationStartedAt;

      const cleanAnswer = formatGeneralOutput(answer);
      const fallbackReason = cleanAnswer && !isBadGroundedAnswer(cleanAnswer)
        ? null
        : 'grounded_llm_invalid_answer';

      if (!cleanAnswer || isBadGroundedAnswer(cleanAnswer)) {
        const fallbackAnswer = buildQuickGroundedAnswer(chunks);

        if (!isExplicitLessonQuestion) {
          return fallbackAnswer
            ? makeResponse({
              text: fallbackAnswer,
              sources,
              answerMode: 'grounded',
              confidence: 'low',
              retrievalMs,
              generationMs,
              topScore: retrievalResult.topScore,
              fallbackReason,
            })
            : answerGeneralQuestion('invalid_grounded_general');
        }

        return makeResponse({
          text: fallbackAnswer ||
            'The lesson has related text, but it does not give enough detail for a complete answer. Try asking about one specific term, step, or section from the lesson.',
          sources: fallbackAnswer ? sources : [],
          answerMode: fallbackAnswer ? 'grounded' : 'status',
          confidence: fallbackAnswer ? 'low' : 'none',
          retrievalMs,
          generationMs,
          topScore: retrievalResult.topScore,
          fallbackReason,
        });
      }

      return makeResponse({
        text: cleanAnswer,
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
      generateLlmText,
      llm,
      shouldLoadEmbeddings,
      waitForAnswerHelperReady,
    ]
  );

  const generateStudyTool = useCallback(
    async (
      tool: 'quiz' | 'flashcards',
      mode: StudyToolMode = 'mcq',
      requestedCount?: number,
      conversationContext?: string
    ): Promise<OfflineAiResponse> => {
      generationCancelledRef.current = false;
      const startedAt = Date.now();
      const makeStudyResponse = async ({
        text,
        sources = [],
        confidence = 'none',
        retrievalMs,
        generationMs,
        topScore = null,
        fallbackReason = null,
      }: {
        text: string;
        sources?: string[];
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
          await saveAiPerformanceMetric({
            bookId,
            answerMode: sources.length > 0 ? 'study_tool' : 'status',
            confidence,
            retrievalMs,
            generationMs,
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

      const toolText = buildSimpleStudyToolFallback(
        tool,
        chunks,
        mode,
        itemCount,
        getStudyToolVariant(conversationContext)
      );
      const sources = chunks.map(formatSourceLabel);
      const finalToolText = toolText;
      const generationMs: number | undefined = undefined;
      const fallbackReason: string | null = hasAnswerHelperPrepared
        ? null
        : 'study_tool_local_fallback_answer_helper_not_prepared';

      if (tool === 'quiz' && mode === 'mcq' && !hasValidMcqQuiz(finalToolText)) {
        return makeStudyResponse({
          text: 'ALAB found readable lesson text, but it does not contain enough distinct facts to build a multiple-choice quiz yet.',
          retrievalMs,
          generationMs,
          topScore: chunks[0]?.score ?? null,
          fallbackReason: fallbackReason ?? 'invalid_mcq_quiz',
        });
      }

      if (tool === 'flashcards' && countFlashcards(finalToolText) === 0) {
        return makeStudyResponse({
          text: 'ALAB found readable lesson text, but it does not contain enough clear terms and definitions to build flashcards yet.',
          retrievalMs,
          generationMs,
          topScore: chunks[0]?.score ?? null,
          fallbackReason: 'invalid_flashcards',
        });
      }

      try {
        await saveGeneratedStudyTool(
          tool,
          bookId,
          chunks.map((chunk) => chunk.id),
          finalToolText
        );
      } catch {
        // The generated message is still useful even if study-tool history fails.
      }

      return makeStudyResponse({
        text: finalToolText,
        sources,
        confidence: 'medium',
        retrievalMs,
        generationMs,
        topScore: chunks[0]?.score ?? null,
        fallbackReason,
      });
    },
    [
      bookId,
      bookTitle,
      embeddings,
      hasAnswerHelperPrepared,
      hasCheckedDownload,
      shouldLoadEmbeddings,
    ]
  );

  const prepareAnswerHelper = useCallback(() => {
    if (hasAnswerHelperPrepared && !shouldLoadLlm) {
      setShouldLoadLlm(true);
    }
  }, [hasAnswerHelperPrepared, shouldLoadLlm]);

  const hasActiveGeneration = useCallback(
    () => Boolean(activeGenerationPromiseRef.current || llmGeneratingRef.current),
    []
  );

  const stopActiveGeneration = useCallback(async () => {
    if (!hasActiveGeneration()) {
      return true;
    }

    generationCancelledRef.current = true;
    interruptLlm();

    const startedAt = Date.now();

    while (hasActiveGeneration() && Date.now() - startedAt < 15000) {
      await delay(50);
    }

    return !hasActiveGeneration();
  }, [hasActiveGeneration, interruptLlm]);

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
    prepareAnswerHelper,
    stopActiveGeneration,
    hasActiveGeneration,
    embedLessonText,
    embeddingModelName,
    isAvailable,
    hasCheckedDownload,
    isAnswerHelperPrepared: hasAnswerHelperPrepared,
    shouldLoadModel: shouldLoadEmbeddings,
    isModelReady: llm.isReady,
    isEmbeddingReady: embeddings.isReady,
    isGenerating: llm.isGenerating,
    llmDownloadProgress: llm.downloadProgress,
    embeddingDownloadProgress: embeddings.downloadProgress,
    error: llm.error ?? embeddings.error,
  };
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

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildSummaryRetrievalQuery(question: string, conversationContext?: string) {
  return [conversationContext, question]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function getStudyToolVariant(conversationContext?: string) {
  if (!conversationContext) {
    return 0;
  }

  let hash = 0;

  for (let index = 0; index < conversationContext.length; index += 1) {
    hash = (hash * 31 + conversationContext.charCodeAt(index)) >>> 0;
  }

  return hash;
}
