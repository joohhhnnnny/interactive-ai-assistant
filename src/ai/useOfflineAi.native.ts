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
  buildStudyToolMessages,
  formatSourceLabel,
  retrieveBookOverviewChunks,
  retrieveRelevantChunksWithMetadata,
  retrieveStudyToolChunks,
} from './retrieval';
import {
  formatGeneralOutput,
  formatStudentOutput,
} from './textCleanup';
import {
  buildPdfSummary,
  buildQuickGroundedAnswer,
  getAnswerIntent,
  isBadGroundedAnswer,
} from './rag/agent/answers';
import {
  buildSimpleStudyToolFallback,
  countFlashcards,
  countValidMcqQuestions,
  getStudyToolItemCount,
  hasValidMcqQuiz,
  normalizeStudyToolOutput,
  StudyToolMode,
} from './rag/agent/studyTools';

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
const studyToolGenerationTimeoutMs = 45000;
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
          llm.generate(
            buildGeneralMessages(question, conversationContext) as Message[]
          ),
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
        llm.generate(
          buildGroundedMessages(question, chunks, conversationContext) as Message[]
        ),
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
      requestedCount?: number,
      conversationContext?: string
    ): Promise<OfflineAiResponse> => {
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
        getConversationVariant(conversationContext)
      );
      const sources = chunks.map(formatSourceLabel);
      let finalToolText = toolText;
      let generationMs: number | undefined;
      let fallbackReason: string | null = hasAnswerHelperPrepared
        ? null
        : 'study_tool_local_fallback_answer_helper_not_prepared';

      if (hasAnswerHelperPrepared && llm.error) {
        fallbackReason = 'study_tool_local_fallback_llm_error';
      } else if (hasAnswerHelperPrepared && !shouldLoadLlm) {
        setShouldLoadLlm(true);
        fallbackReason = 'study_tool_local_fallback_llm_lazy_loading';
      } else if (hasAnswerHelperPrepared && !llm.isReady) {
        fallbackReason = 'study_tool_local_fallback_llm_not_ready';
      } else if (hasAnswerHelperPrepared && llm.isReady) {
        llm.configure({ generationConfig });

        const generationStartedAt = Date.now();
        const generatedText = await withTimeout(
          llm.generate(
            buildStudyToolMessages(tool, bookTitle, chunks, {
              itemCount,
              mode,
              conversationContext,
            }) as Message[]
          ),
          studyToolGenerationTimeoutMs,
          '',
          llm.interrupt
        );
        generationMs = Date.now() - generationStartedAt;
        const cleanGeneratedText = normalizeStudyToolOutput(generatedText);

        if (isUsableStudyToolOutput(tool, mode, cleanGeneratedText, itemCount)) {
          finalToolText = cleanGeneratedText;
          fallbackReason = null;
        } else {
          fallbackReason = 'study_tool_local_fallback_invalid_llm_output';
        }
      }

      if (tool === 'quiz' && mode === 'mcq' && !hasValidMcqQuiz(finalToolText)) {
        return makeStudyResponse({
          text: 'ALAB needs a little more readable lesson text before making a multiple-choice quiz. Please try again after the source finishes analyzing.',
          retrievalMs,
          topScore: chunks[0]?.score ?? null,
          fallbackReason: fallbackReason ?? 'invalid_mcq_quiz',
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
        confidence: fallbackReason ? 'medium' : 'high',
        retrievalMs,
        topScore: chunks[0]?.score ?? null,
        fallbackReason,
        generationMs,
      });
    },
    [
      bookId,
      bookTitle,
      embeddings,
      hasAnswerHelperPrepared,
      hasCheckedDownload,
      llm,
      shouldLoadEmbeddings,
      shouldLoadLlm,
    ]
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

function getConversationVariant(conversationContext?: string) {
  if (!conversationContext) {
    return 0;
  }

  let hash = 0;

  for (let index = 0; index < conversationContext.length; index += 1) {
    hash = ((hash << 5) - hash + conversationContext.charCodeAt(index)) | 0;
  }

  return Math.abs(hash);
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

function isUsableStudyToolOutput(
  tool: 'quiz' | 'flashcards',
  mode: StudyToolMode,
  text: string,
  targetCount: number
) {
  if (!text) {
    return false;
  }

  if (tool === 'flashcards') {
    return countFlashcards(text) >= Math.min(targetCount, 20);
  }

  if (mode !== 'mcq') {
    return /^question\s*[:.)-]/im.test(text) && /^answer\s*[:.)-]/im.test(text);
  }

  return countValidMcqQuestions(text) >= Math.min(targetCount, 10);
}
