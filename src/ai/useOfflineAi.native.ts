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
  buildGeneralMessages,
  buildGroundedMessages,
  buildStudyToolMessages,
  formatSourceLabel,
  retrieveBookOverviewChunks,
  retrieveRelevantChunksWithMetadata,
  retrieveStudyToolChunks,
} from './retrieval';
import {
  cleanStudentReadableText,
  cleanLessonText,
  formatGeneralOutput,
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
const answerHelperWarmupTimeoutMs = 90000;
const studyToolGenerationTimeoutMs = 60000;
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
const studyToolGenerationConfig = {
  ...generationConfig,
  temperature: 0.12,
  topP: 0.72,
  minP: 0.03,
  repetitionPenalty: 1.12,
  outputTokenBatchSize: 6,
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
    async (question: string): Promise<OfflineAiResponse> => {
      generationCancelledRef.current = false;
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
          buildGeneralMessages(question) as Message[],
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
          buildGroundedMessages(question, chunks) as Message[],
          heavyAnswerTimeoutMs
        );
        const generationMs = Date.now() - generationStartedAt;
        const cleanAnswer = formatGeneralOutput(answer);

        if (!cleanAnswer || isBadGroundedAnswer(cleanAnswer)) {
          const fallbackSummary =
            buildLessonOverviewFallback(question, chunks) ||
            buildGroundedRecoveryAnswer(question, chunks);

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
        if (!isExplicitLessonRequest(question)) {
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
        !isExplicitLessonRequest(question)
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
        buildGroundedMessages(question, chunks) as Message[],
        heavyAnswerTimeoutMs
      );
      const generationMs = Date.now() - generationStartedAt;

      const cleanAnswer = formatGeneralOutput(answer);
      const fallbackReason = cleanAnswer && !isBadGroundedAnswer(cleanAnswer)
        ? null
        : 'grounded_llm_invalid_answer';

      if (!cleanAnswer || isBadGroundedAnswer(cleanAnswer)) {
        const fallbackAnswer = buildGroundedRecoveryAnswer(question, chunks);

        if (!isExplicitLessonRequest(question)) {
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
      requestedCount?: number
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

      let toolText = '';
      let confidence: AiAnswerConfidence = 'none';
      let generationMs: number | undefined;
      let fallbackReason: string | null = null;

      if (!hasAnswerHelperPrepared) {
        return makeStudyResponse({
          text: `Please finish preparing the study helper from My Books before generating ${tool === 'quiz' ? 'quizzes' : 'flashcards'}.`,
          retrievalMs,
          topScore: chunks[0]?.score ?? null,
          fallbackReason: 'study_tool_answer_helper_not_prepared',
        });
      }

      if (llmErrorRef.current || llm.error) {
        return makeStudyResponse({
          text: `The study helper had trouble opening on this device, so ALAB could not generate ${tool === 'quiz' ? 'the quiz' : 'flashcards'} properly. Please close other apps and try again.`,
          retrievalMs,
          topScore: chunks[0]?.score ?? null,
          fallbackReason: 'study_tool_llm_error',
        });
      }

      const isAnswerHelperReady = llm.isReady || await waitForAnswerHelperReady();

      if (!isAnswerHelperReady) {
        return makeStudyResponse({
          text: `ALAB is still opening the study helper so it can generate ${tool === 'quiz' ? 'the quiz' : 'flashcards'} properly. Please try again in a moment.`,
          retrievalMs,
          topScore: chunks[0]?.score ?? null,
          fallbackReason: 'study_tool_llm_warmup_timeout',
        });
      }

      llm.configure({ generationConfig: studyToolGenerationConfig });

      const generationStartedAt = Date.now();
      const batchSize = getStudyToolGenerationBatchSize(tool, mode, itemCount);
      const generatedParts: string[] = [];

      for (let generatedCount = 0; generatedCount < itemCount; generatedCount += batchSize) {
        if (generationCancelledRef.current) {
          break;
        }

        const batchCount = Math.min(batchSize, itemCount - generatedCount);
        let batchText = '';

        for (
          let attempt = 0;
          attempt < 2 && !batchText.trim() && !generationCancelledRef.current;
          attempt += 1
        ) {
          batchText = await generateLlmText(
            buildStudyToolMessages(tool, bookTitle, chunks, batchCount, mode) as Message[],
            studyToolGenerationTimeoutMs
          );
        }

        if (batchText.trim()) {
          generatedParts.push(batchText);
        }
      }

      const generatedToolText = generatedParts.join('\n\n');
      generationMs = Date.now() - generationStartedAt;
      const cleanGeneratedToolText = cleanStudyToolOutput(generatedToolText);
      const preparedTool = prepareStudyToolText(
        tool,
        cleanGeneratedToolText,
        chunks,
        itemCount,
        mode
      );

      toolText = preparedTool.text;
      confidence = preparedTool.confidence;
      fallbackReason = preparedTool.fallbackReason;

      if (tool === 'quiz' && mode === 'mcq' && !hasValidMcqQuiz(toolText)) {
        return makeStudyResponse({
          text: 'ALAB found readable lesson text, but it does not contain enough distinct facts to build a multiple-choice quiz yet.',
          retrievalMs,
          generationMs,
          topScore: chunks[0]?.score ?? null,
          fallbackReason: 'invalid_mcq_quiz',
        });
      }

      if (tool === 'flashcards' && !hasValidFlashcards(toolText)) {
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
          toolText
        );
      } catch {
        // The generated message is still useful even if study-tool history fails.
      }

      return makeStudyResponse({
        text: toolText,
        sources: chunks.map(formatSourceLabel),
        confidence,
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
      generateLlmText,
      hasAnswerHelperPrepared,
      hasCheckedDownload,
      llm,
      shouldLoadEmbeddings,
      waitForAnswerHelperReady,
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

type PreparedStudyToolText = {
  text: string;
  confidence: AiAnswerConfidence;
  fallbackReason: string | null;
};

function prepareStudyToolText(
  tool: 'quiz' | 'flashcards',
  generatedText: string,
  chunks: { text: string }[],
  requestedCount: number,
  mode: StudyToolMode
): PreparedStudyToolText {
  if (tool === 'quiz' && mode === 'mcq') {
    return prepareMcqQuizText(generatedText, chunks, requestedCount);
  }

  if (tool === 'flashcards') {
    return prepareFlashcardText(generatedText, chunks, requestedCount);
  }

  return {
    text: generatedText,
    confidence: generatedText.trim() ? 'medium' : 'none',
    fallbackReason: generatedText.trim() ? null : 'study_tool_llm_empty',
  };
}

function prepareMcqQuizText(
  generatedText: string,
  chunks: { text: string }[],
  requestedCount: number
): PreparedStudyToolText {
  const lessonConcepts = getQuizConcepts(chunks);
  const generatedBlocks = uniqueMcqBlocks(
    getValidMcqBlocks(generatedText).filter((block) =>
      isProfessionalMcqBlock(block) &&
      isGroundedMcqBlock(block, lessonConcepts)
    )
  ).slice(0, requestedCount);
  const fallbackBlocks = buildProfessorMcqBlocks(
    lessonConcepts,
    requestedCount,
    generatedBlocks
  );
  const blocks = uniqueMcqBlocks([
    ...generatedBlocks,
    ...fallbackBlocks,
  ]).slice(0, requestedCount);
  const minimumQuizCount = getMinimumQuizCount(requestedCount);

  if (blocks.length < minimumQuizCount) {
    return {
      text: '',
      confidence: 'none',
      fallbackReason: blocks.length === 0
        ? 'study_tool_quiz_no_valid_items'
        : 'study_tool_quiz_too_few_distinct_items',
    };
  }

  return {
    text: renumberMcqBlocks(blocks).join('\n\n'),
    confidence: blocks.length >= requestedCount ? 'high' : 'low',
    fallbackReason:
      generatedBlocks.length >= requestedCount
        ? null
        : generatedBlocks.length > 0
          ? 'study_tool_quiz_repaired'
          : 'study_tool_quiz_fallback',
  };
}

function prepareFlashcardText(
  generatedText: string,
  chunks: { text: string }[],
  requestedCount: number
): PreparedStudyToolText {
  const generatedCards = getValidFlashcardBlocks(generatedText);
  const fallbackCards = buildFallbackFlashcards(
    chunks,
    requestedCount,
    generatedCards
  );
  const cards = uniqueFlashcards([
    ...generatedCards,
    ...fallbackCards,
  ]).slice(0, requestedCount);

  if (cards.length === 0) {
    return {
      text: '',
      confidence: 'none',
      fallbackReason: 'study_tool_flashcards_no_valid_items',
    };
  }

  return {
    text: formatFlashcards(cards),
    confidence: cards.length >= getMinimumFlashcardCount(requestedCount) ? 'high' : 'low',
    fallbackReason:
      generatedCards.length >= getMinimumFlashcardCount(requestedCount)
        ? null
        : generatedCards.length > 0
          ? 'study_tool_flashcards_repaired'
          : 'study_tool_flashcards_fallback',
  };
}

function hasValidMcqQuiz(text: string) {
  return countValidMcqQuestions(text) > 0;
}

function countValidMcqQuestions(text: string) {
  return getValidMcqBlocks(text).length;
}

function getValidMcqBlocks(text: string) {
  return text
    .split(/(?=Question\s*\d*\s*[:.)-])/i)
    .map((block) => block.trim())
    .filter((block) => /^question\s*\d*\s*[:.)-]/i.test(block))
    .filter(hasValidMcqBlock);
}

function hasValidFlashcards(text: string) {
  return countValidFlashcards(text) > 0;
}

function countValidFlashcards(text: string) {
  return getValidFlashcardBlocks(text).length;
}

function getValidFlashcardBlocks(text: string) {
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const cards: { front: string; back: string }[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const frontLine = lines[index];
    const backLine = lines[index + 1];

    if (!/^front\s*:/i.test(frontLine) || !/^back\s*:/i.test(backLine ?? '')) {
      continue;
    }

    const front = cleanFlashcardFront(frontLine.replace(/^front\s*:/i, ''));
    const back = cleanFlashcardBack((backLine ?? '').replace(/^back\s*:/i, ''));

    if (isValidGeneratedFlashcard(front, back)) {
      cards.push({ front, back });
    }

    index += 1;
  }

  return cards;
}

function cleanFlashcardFront(front: string) {
  return cleanStudyTerm(front.replace(/^[-*\d.)\s]+/, ''));
}

function cleanFlashcardBack(back: string) {
  return cleanStudentReadableText(back.replace(/^[-*\d.)\s]+/, ''));
}

function isValidGeneratedFlashcard(front: string, back: string) {
  return (
    isUsefulTerm(front) &&
    isUsefulFlashcardFront(front) &&
    !isWeakQuizTerm(front) &&
    isUsefulFlashcardBack(front, back)
  );
}

function getMinimumFlashcardCount(requestedCount: number) {
  return Math.min(requestedCount, Math.max(6, Math.ceil(requestedCount * 0.5)));
}

function getMinimumQuizCount(requestedCount: number) {
  return Math.min(requestedCount, Math.max(3, Math.ceil(requestedCount * 0.35)));
}

type QuizConcept = {
  term: string;
  answer: string;
  sourceText: string;
  kind: 'definition' | 'purpose' | 'process' | 'fact';
};

function buildProfessorMcqBlocks(
  concepts: QuizConcept[],
  requestedCount: number,
  existingBlocks: string[]
) {
  const blocks: string[] = [];
  const usedKeys = new Set(existingBlocks.map(getMcqBlockKey).filter(Boolean));
  const usedOptionSets = new Set(
    existingBlocks.map(getMcqOptionSetKey).filter(Boolean)
  );
  const conceptPool = concepts
    .filter(isUsefulFallbackQuizConcept)
    .slice(0, requestedCount * 8);

  for (const concept of conceptPool) {
    if (blocks.length >= requestedCount) {
      break;
    }

    const distractors = buildQuizDistractors(concept, conceptPool, blocks.length);

    if (distractors.length < 3) {
      continue;
    }

    const block = formatTermChoiceMcqBlock(
      blocks.length + 1,
      concept,
      distractors,
      blocks.length
    );

    if (!block) {
      continue;
    }

    const key = getMcqBlockKey(block);
    const optionSetKey = getMcqOptionSetKey(block);

    if (
      key &&
      optionSetKey &&
      !usedKeys.has(key) &&
      !usedOptionSets.has(optionSetKey) &&
      isProfessionalMcqBlock(block)
    ) {
      usedKeys.add(key);
      usedOptionSets.add(optionSetKey);
      blocks.push(block);
    }
  }

  return blocks;
}

function getQuizConcepts(chunks: { text: string }[]) {
  const factConcepts = extractLessonFacts(chunks)
    .filter((fact) => isAnswerableFact(fact.term, fact.detail))
    .map((fact): QuizConcept => ({
      term: cleanStudyTerm(fact.term),
      answer: formatFactAnswer(fact),
      sourceText: fact.sourceText,
      kind: classifyQuizConcept(fact.sourceText, fact.detail),
    }));
  const sentenceConcepts = uniqueTexts(splitSentences(chunks))
    .map(deriveSentenceQuizConcept)
    .filter((concept): concept is QuizConcept => Boolean(concept));

  return uniqueQuizConcepts([
    ...factConcepts,
    ...sentenceConcepts,
  ]).filter(isUsefulQuizConcept);
}

function deriveSentenceQuizConcept(sentence: string): QuizConcept | null {
  if (isQuestionLikeText(sentence)) {
    return null;
  }

  const term = deriveFlashcardTerm(sentence);

  if (!term) {
    return null;
  }

  return {
    term,
    answer: completeSentence(sentence),
    sourceText: sentence,
    kind: classifyQuizConcept(sentence, sentence),
  };
}

function classifyQuizConcept(sourceText: string, detail: string): QuizConcept['kind'] {
  const normalized = `${sourceText} ${detail}`.toLowerCase();

  if (/\b(first|second|then|next|finally|step|process|how|create|build|use)\b/.test(normalized)) {
    return 'process';
  }

  if (/\b(used to|used for|helps|allows|purpose|role|function|benefit|important)\b/.test(normalized)) {
    return 'purpose';
  }

  if (/\b(is|are|means|refers to|defined as|called)\b/.test(normalized)) {
    return 'definition';
  }

  return 'fact';
}

function isUsefulQuizConcept(concept: QuizConcept) {
  const normalizedAnswer = normalizeOption(concept.answer);

  return (
    isUsefulTerm(concept.term) &&
    !isWeakQuizTerm(concept.term) &&
    concept.answer.length >= 30 &&
    concept.answer.length <= 220 &&
    normalizedAnswer.length >= 24 &&
    !normalizedAnswer.includes('page ') &&
    !normalizedAnswer.includes('source ') &&
    !normalizedAnswer.includes('uploaded pdf') &&
    !normalizedAnswer.includes('according to') &&
    !isNoisyLessonText(concept.answer)
  );
}

function uniqueQuizConcepts(concepts: QuizConcept[]) {
  const seenTerms = new Set<string>();
  const seenAnswers = new Set<string>();
  const unique: QuizConcept[] = [];

  for (const concept of concepts) {
    const termKey = normalizeOption(concept.term);
    const answerKey = normalizeOption(concept.answer);

    if (!termKey || !answerKey || seenTerms.has(termKey) || seenAnswers.has(answerKey)) {
      continue;
    }

    seenTerms.add(termKey);
    seenAnswers.add(answerKey);
    unique.push(concept);
  }

  return unique;
}

function buildFallbackFlashcards(
  chunks: { text: string }[],
  requestedCount: number,
  existingCards: { front: string; back: string }[]
) {
  const cards: { front: string; back: string }[] = [];
  const usedFronts = new Set(existingCards.map((card) => normalizeOption(card.front)));
  const facts = [
    ...extractLessonFacts(chunks).filter(isUsefulFlashcardFact),
    ...extractSentenceFlashcardFacts(chunks),
  ];

  for (const fact of facts) {
    if (cards.length >= requestedCount) {
      break;
    }

    const front = cleanFlashcardFront(fact.term);
    const back = cleanFlashcardBack(formatFactAnswer(fact, front));
    const key = normalizeOption(front);

    if (
      key &&
      !usedFronts.has(key) &&
      isValidGeneratedFlashcard(front, back)
    ) {
      usedFronts.add(key);
      cards.push({ front, back });
    }
  }

  return cards;
}

function extractSentenceFlashcardFacts(chunks: { text: string }[]) {
  return uniqueTexts(splitSentences(chunks))
    .map((sentence): LessonFact | null => {
      if (isQuestionLikeText(sentence)) {
        return null;
      }

      const term = deriveFlashcardTerm(sentence);

      if (!term) {
        return null;
      }

      return {
        term,
        detail: sentence,
        sourceText: sentence,
        kind: 'term',
      };
    })
    .filter((fact): fact is LessonFact => Boolean(fact))
    .filter((fact) => {
      const back = fact.detail.replace(/_____+/g, fact.term);

      return (
        isUsefulTerm(fact.term) &&
        isUsefulFlashcardFront(fact.term) &&
        !isWeakQuizTerm(fact.term) &&
        isUsefulFlashcardBack(fact.term, back)
      );
    });
}

function deriveFlashcardTerm(sentence: string) {
  const cleanSentence = cleanChunkText(sentence);
  const definitionMatch = cleanSentence.match(
    /^([A-Za-z][A-Za-z0-9#+ /()-]{2,45})\s+(?:is|are|was|were|means|refers to|describes|uses|allows|helps|contains|includes|can)\b/i
  );

  if (definitionMatch) {
    const term = cleanStudyTerm(definitionMatch[1]);

    if (
      isUsefulTerm(term) &&
      isUsefulFlashcardFront(term) &&
      !isWeakQuizTerm(term)
    ) {
      return term;
    }
  }

  const namedTermPattern = /\b([A-Z][A-Za-z0-9#+/()-]{2,30}(?:\s+[A-Z][A-Za-z0-9#+/()-]{1,30}){0,3})\b/g;
  const namedTerms = Array.from(cleanSentence.matchAll(namedTermPattern))
    .map((match) => ({
      term: cleanStudyTerm(match[1]),
      startsSentence: (match.index ?? 0) === 0,
    }));

  for (const { term, startsSentence } of namedTerms) {
    const words = normalizeOption(term).split(/\s+/).filter(Boolean);

    if (startsSentence && words.length === 1) {
      continue;
    }

    if (
      isUsefulTerm(term) &&
      isUsefulFlashcardFront(term) &&
      !isWeakQuizTerm(term)
    ) {
      return term;
    }
  }

  return null;
}

function formatTermChoiceMcqBlock(
  number: number,
  concept: QuizConcept,
  distractors: QuizConcept[],
  offset: number
) {
  const correctAnswer = concept.term;
  const baseOptions = buildDistinctQuizOptions([
    correctAnswer,
    ...distractors.map((distractor) => distractor.term),
  ]);

  if (baseOptions.length < 4) {
    return null;
  }

  const options = rotateStudyItems(baseOptions, offset);
  const correctIndex = options.findIndex(
    (option) => normalizeAnswerText(option) === normalizeAnswerText(correctAnswer)
  );
  const answerIndex = correctIndex >= 0 ? correctIndex : 0;
  const answerLetter = String.fromCharCode(65 + answerIndex);
  const detail = buildConceptQuestionDetail(concept);

  return [
    `Question ${number}: Which lesson concept best matches this detail: ${detail}?`,
    `A. ${options[0]}`,
    `B. ${options[1]}`,
    `C. ${options[2]}`,
    `D. ${options[3]}`,
    `Correct answer: ${answerLetter}. ${options[answerIndex]}`,
    `Explanation: ${concept.answer}`,
  ].join('\n');
}

function buildQuizDistractors(
  concept: QuizConcept,
  concepts: QuizConcept[],
  offset: number
) {
  const correctTerm = concept.term;
  const candidates = concepts
    .filter((item) => normalizeOption(item.term) !== normalizeOption(concept.term))
    .filter((item) => isPlausibleQuizDistractor(correctTerm, item.term));
  const distinctCandidates: QuizConcept[] = [];

  for (const candidate of rotateStudyItems(candidates, offset)) {
    if (
      distinctCandidates.some((existing) =>
        areQuizOptionsTooSimilar(existing.term, candidate.term)
      )
    ) {
      continue;
    }

    distinctCandidates.push(candidate);

    if (distinctCandidates.length === 3) {
      break;
    }
  }

  return distinctCandidates;
}

function isPlausibleQuizDistractor(correctAnswer: string, distractor: string) {
  const cleanDistractor = cleanStudentReadableText(distractor).replace(/\s+/g, ' ').trim();

  return (
    cleanDistractor.length >= 3 &&
    cleanDistractor.length <= 80 &&
    normalizeAnswerText(cleanDistractor) !== normalizeAnswerText(correctAnswer) &&
    !areQuizOptionsTooSimilar(correctAnswer, cleanDistractor) &&
    !isNoisyLessonText(cleanDistractor) &&
    isUsefulTerm(cleanDistractor) &&
    isUsefulFlashcardFront(cleanDistractor) &&
    !isWeakQuizTerm(cleanDistractor)
  );
}

function buildConceptQuestionDetail(concept: QuizConcept) {
  const normalizedTerm = normalizeOption(concept.term);
  const detail = cleanStudentReadableText(concept.answer)
    .replace(new RegExp(`\\b${escapeRegExp(concept.term)}\\b`, 'gi'), 'this concept')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanDetail = normalizeOption(detail).includes(normalizedTerm)
    ? concept.answer
    : detail;

  return `"${shortText(cleanDetail, 95)}"`;
}

function isUsefulFallbackQuizConcept(concept: QuizConcept) {
  return (
    isUsefulTerm(concept.term) &&
    isUsefulFlashcardFront(concept.term) &&
    !isWeakQuizTerm(concept.term) &&
    concept.answer.length >= 32 &&
    concept.answer.length <= 190 &&
    !isQuestionLikeText(concept.answer) &&
    !isNoisyLessonText(concept.answer)
  );
}

function buildDistinctQuizOptions(options: string[]) {
  const distinctOptions: string[] = [];

  for (const option of options) {
    const cleanOption = cleanStudentReadableText(option).replace(/\s+/g, ' ').trim();

    if (
      cleanOption &&
      !distinctOptions.some((existingOption) =>
        areQuizOptionsTooSimilar(existingOption, cleanOption)
      )
    ) {
      distinctOptions.push(cleanOption);
    }

    if (distinctOptions.length === 4) {
      break;
    }
  }

  return distinctOptions.slice(0, 4);
}

function uniqueMcqBlocks(blocks: string[]) {
  const seen = new Set<string>();
  const seenOptionSets = new Set<string>();
  const unique: string[] = [];

  for (const block of blocks) {
    const key = getMcqBlockKey(block);
    const optionSetKey = getMcqOptionSetKey(block);

    if (!key || !optionSetKey || seen.has(key) || seenOptionSets.has(optionSetKey)) {
      continue;
    }

    seen.add(key);
    seenOptionSets.add(optionSetKey);
    unique.push(block);
  }

  return unique;
}

function getMcqBlockKey(block: string) {
  const question = block.match(/^Question\s*\d*\s*[:.)-]\s*(.+)$/im)?.[1] ?? '';
  const answer = block.match(/(?:^|\n)Correct\s*answer\s*:\s*[A-D][.)]?\s*(.+)$/i)?.[1] ?? '';

  return normalizeOption(`${question} ${answer}`);
}

function getMcqOptionSetKey(block: string) {
  const options = [...getMcqOptions(block).values()]
    .map(normalizeAnswerText)
    .filter(Boolean)
    .sort();

  return options.length === 4 ? options.join('|') : '';
}

function renumberMcqBlocks(blocks: string[]) {
  return blocks.map((block, index) =>
    block.replace(/^Question\s*\d*\s*[:.)-]\s*/i, `Question ${index + 1}: `)
  );
}

function uniqueFlashcards(cards: { front: string; back: string }[]) {
  const seen = new Set<string>();
  const unique: { front: string; back: string }[] = [];

  for (const card of cards) {
    const front = cleanFlashcardFront(card.front);
    const back = cleanFlashcardBack(card.back);
    const key = normalizeOption(front);

    if (!key || seen.has(key) || !isValidGeneratedFlashcard(front, back)) {
      continue;
    }

    seen.add(key);
    unique.push({ front, back });
  }

  return unique;
}

function formatFlashcards(cards: { front: string; back: string }[]) {
  return cards
    .map((card) =>
      [
        `Front: ${card.front}`,
        `Back: ${card.back}`,
      ].join('\n')
    )
    .join('\n\n');
}

function rotateStudyItems<T>(items: T[], offset: number) {
  if (items.length === 0) {
    return items;
  }

  const start = offset % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function completeSentence(text: string) {
  const cleanText = cleanStudentReadableText(text).replace(/\s+/g, ' ').trim();

  if (!cleanText) {
    return cleanText;
  }

  const capitalized = `${cleanText.charAt(0).toUpperCase()}${cleanText.slice(1)}`;

  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function cleanStudyToolOutput(text: string) {
  return cleanStudentReadableText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n(?=Question\s*\d*\s*[:.)-])/gi, '\n\n')
    .replace(/\n(?=Front\s*:)/gi, '\n\n')
    .trim();
}

function hasValidMcqBlock(block: string) {
  const options = getMcqOptions(block);
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

  const answerMatchesOption =
    !answerText ||
    normalizeAnswerText(answerText) === normalizeAnswerText(correctOption) ||
    normalizeAnswerText(answerText).includes(normalizeAnswerText(correctOption));

  return answerMatchesOption && hasMeaningfullyDistinctOptions([...options.values()]);
}

function getMcqOptions(block: string) {
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

  return options;
}

function isProfessionalMcqBlock(block: string) {
  if (!hasValidMcqBlock(block)) {
    return false;
  }

  const question = block.match(/^Question\s*\d*\s*[:.)-]\s*(.+)$/im)?.[1] ?? '';
  const options = [...getMcqOptions(block).values()];

  return (
    isProfessionalQuizQuestion(question) &&
    options.every(isProfessionalQuizOption) &&
    !hasRepeatedOptionOpening(options)
  );
}

function isGroundedMcqBlock(block: string, concepts: QuizConcept[]) {
  if (concepts.length === 0) {
    return true;
  }

  const blockText = normalizeOption(block);
  const lessonKeywords = getStudyToolKeywords(concepts);
  let matchCount = 0;

  if (lessonKeywords.size === 0) {
    return true;
  }

  for (const keyword of lessonKeywords) {
    if (blockText.includes(keyword)) {
      matchCount += 1;
    }

    if (matchCount >= 1) {
      return true;
    }
  }

  return false;
}

function getStudyToolKeywords(concepts: QuizConcept[]) {
  const keywords = new Set<string>();

  for (const concept of concepts) {
    for (const value of [concept.term, concept.answer]) {
      const tokens = normalizeOption(value)
        .split(/\s+/)
        .filter((token) =>
          token.length > 3 &&
          !quizOptionStopWords.has(token) &&
          !answerFallbackStopWords.has(token)
        );

      for (const token of tokens.slice(0, 5)) {
        keywords.add(token);
      }
    }
  }

  return keywords;
}

function isProfessionalQuizQuestion(question: string) {
  const normalized = normalizeOption(question);
  const words = normalized.split(/\s+/).filter(Boolean);

  return (
    question.length >= 24 &&
    question.length <= 150 &&
    words.length >= 5 &&
    !normalized.includes('which statement best matches the lesson') &&
    !normalized.includes('which answer best matches this lesson idea') &&
    !normalized.includes('what does the lesson say about') &&
    !normalized.includes('page ') &&
    !normalized.includes('source ') &&
    !normalized.includes('chunk') &&
    !normalized.includes('uploaded pdf') &&
    !hasWeakQuizFocus(question) &&
    !isNoisyLessonText(question)
  );
}

function isProfessionalQuizOption(option: string) {
  const normalized = normalizeOption(option);
  const words = normalized.split(/\s+/).filter(Boolean);
  const isTermOption =
    option.length >= 3 &&
    option.length <= 80 &&
    words.length >= 1 &&
    words.length <= 6 &&
    isUsefulTerm(option) &&
    isUsefulFlashcardFront(option) &&
    !isWeakQuizTerm(option);
  const isSentenceOption =
    option.length >= 24 &&
    option.length <= 220 &&
    words.length >= 5;

  return (
    (isTermOption || isSentenceOption) &&
    !normalized.includes('this statement gives the opposite meaning') &&
    !normalized.includes('this detail is unrelated') &&
    !normalized.includes('this option changes the main meaning') &&
    !normalized.includes('not supported by the lesson') &&
    !normalized.includes('visual layout feature') &&
    !normalized.includes('random classroom example') &&
    !normalized.includes('decorative label') &&
    !normalized.includes('background detail') &&
    !normalized.includes('minor note about formatting') &&
    !normalized.includes('record of when the material was saved') &&
    !normalized.includes('physical computer part') &&
    !normalized.includes('web address used only') &&
    !normalized.includes('page ') &&
    !normalized.includes('source ') &&
    !normalized.includes('chunk') &&
    !normalized.includes('uploaded pdf') &&
    !isNoisyLessonText(option)
  );
}

function hasRepeatedOptionOpening(options: string[]) {
  const openings = options
    .map((option) =>
      normalizeOption(option)
        .split(/\s+/)
        .filter((word) => !quizOptionStopWords.has(word))
        .slice(0, 3)
        .join(' ')
    )
    .filter(Boolean);
  const uniqueOpenings = new Set(openings);

  return openings.length >= 3 && uniqueOpenings.size <= 2;
}

function normalizeAnswerText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hasMeaningfullyDistinctOptions(options: string[]) {
  if (options.length !== 4) {
    return false;
  }

  const cleanOptions = options
    .map((option) => cleanStudentReadableText(option).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (cleanOptions.length !== 4) {
    return false;
  }

  for (let leftIndex = 0; leftIndex < cleanOptions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < cleanOptions.length; rightIndex += 1) {
      if (areQuizOptionsTooSimilar(cleanOptions[leftIndex], cleanOptions[rightIndex])) {
        return false;
      }
    }
  }

  return true;
}

function areQuizOptionsTooSimilar(left: string, right: string) {
  const normalizedLeft = normalizeOption(left);
  const normalizedRight = normalizeOption(right);

  if (!normalizedLeft || !normalizedRight || normalizedLeft === normalizedRight) {
    return true;
  }

  const shorter = normalizedLeft.length < normalizedRight.length
    ? normalizedLeft
    : normalizedRight;
  const longer = normalizedLeft.length < normalizedRight.length
    ? normalizedRight
    : normalizedLeft;

  if (shorter.length >= 16 && longer.includes(shorter)) {
    return true;
  }

  const leftTokens = getMeaningfulOptionTokens(normalizedLeft);
  const rightTokens = getMeaningfulOptionTokens(normalizedRight);

  if (leftTokens.length < 3 || rightTokens.length < 3) {
    return false;
  }

  const rightSet = new Set(rightTokens);
  const intersection = leftTokens.filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const overlap = intersection / Math.max(1, union);
  const coverage = intersection / Math.max(1, Math.min(leftTokens.length, rightTokens.length));

  return overlap >= 0.72 || coverage >= 0.86;
}

function getMeaningfulOptionTokens(value: string) {
  return value
    .split(/\s+/)
    .map((token) => token.replace(/s$/, ''))
    .filter((token) => token.length > 2 && !quizOptionStopWords.has(token));
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

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isSummaryRequest(question: string) {
  const normalized = question.toLowerCase();

  return (
    normalized.includes('summarize') ||
    normalized.includes('summary') ||
    normalized.includes('sum up') ||
    normalized.includes('overview') ||
    normalized.includes('road map') ||
    normalized.includes('roadmap') ||
    normalized.includes('main idea') ||
    /\blist\b.+\b(sections?|topics?|chapters?|lessons?|concepts?)\b/.test(normalized) ||
    /\b(sections?|topics?|chapters?|lessons?|concepts?)\b.+\blist\b/.test(normalized) ||
    /\btable of contents\b/.test(normalized) ||
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
    isSimpleGeneralKnowledgeQuestion(question) ||
    /\b(write|create|make|give me|show me)\b.+\b(code|program|example|template|letter|essay|story|sentence|paragraph)\b/.test(normalized) ||
    /\btranslate\b|\bgrammar\b|\brewrite\b|\bproofread\b/.test(normalized)
  ) {
    return true;
  }

  return /^[\d\s+\-*/().=]+$/.test(normalized.trim());
}

function isSimpleGeneralKnowledgeQuestion(question: string) {
  const normalized = normalizeOption(question);

  return (
    /^(what is|what are|define|meaning of|what does)\b/.test(normalized) ||
    /\b(explain|example of|give an example of)\b/.test(normalized)
  );
}

function buildLessonOverviewFallback(
  question: string,
  chunks: { text: string }[]
) {
  const requestedRoadmap = isSummaryRequest(question);
  const facts = extractLessonFacts(chunks)
    .filter(isUsefulFlashcardFact)
    .slice(0, 8);

  if (requestedRoadmap && facts.length >= 3) {
    return formatGeneralOutput([
      'Here is a study roadmap from your lesson:',
      '',
      ...facts.map((fact, index) =>
        `${index + 1}. ${fact.term} - ${shortText(fact.detail.replace(/_____+/g, fact.term), 120)}`
      ),
      '',
      'Start with the first few ideas, then use the later ones for review questions and flashcards.',
    ].join('\n'));
  }

  const sentences = uniqueTexts(splitSentences(chunks)).slice(0, 5);

  if (sentences.length === 0) {
    return null;
  }

  return formatGeneralOutput([
    requestedRoadmap
      ? 'Here are the main lesson points I found:'
      : 'Here is the clearest summary I can prepare from the lesson text:',
    '',
    ...sentences.map((sentence, index) => `${index + 1}. ${shortText(sentence, 140)}`),
  ].join('\n'));
}

function buildGroundedRecoveryAnswer(
  question: string,
  chunks: { text: string }[]
) {
  const rankedSentences = rankLessonSentencesForQuestion(question, chunks).slice(0, 4);

  if (rankedSentences.length === 0) {
    return null;
  }

  const topic = extractQuestionTopic(question);
  const mainPoint = rankedSentences[0];
  const details = rankedSentences.slice(1, 4);

  return formatGeneralOutput([
    `Based on the lesson, ${topic} is connected to this main point:`,
    '',
    shortText(mainPoint, 190),
    details.length > 0 ? '' : null,
    details.length > 0 ? 'Helpful lesson details:' : null,
    ...details.map((detail, index) => `${index + 1}. ${shortText(detail, 160)}`),
    '',
    `Use this as your starting answer, then ask about a specific term or step if you want a more focused explanation.`,
  ].filter(Boolean).join('\n'));
}

function rankLessonSentencesForQuestion(
  question: string,
  chunks: { text: string }[]
) {
  const keywords = getQuestionKeywords(question);
  const sentences = uniqueTexts(splitSentences(chunks));

  return sentences
    .map((sentence) => ({
      sentence,
      score: scoreSentenceForQuestion(sentence, keywords),
    }))
    .filter((item) => item.score > 0 || keywords.length === 0)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.sentence);
}

function scoreSentenceForQuestion(sentence: string, keywords: string[]) {
  if (keywords.length === 0) {
    return 1;
  }

  const normalizedSentence = normalizeOption(sentence);
  let score = 0;

  for (const keyword of keywords) {
    if (normalizedSentence.includes(keyword)) {
      score += keyword.length > 5 ? 2 : 1;
    }
  }

  return score;
}

function getQuestionKeywords(question: string) {
  return Array.from(
    new Set(
      normalizeOption(question)
        .split(/\s+/)
        .filter((word) => word.length > 2 && !answerFallbackStopWords.has(word))
    )
  ).slice(0, 8);
}

function extractQuestionTopic(question: string) {
  const cleanQuestion = cleanStudentReadableText(question)
    .replace(/[?!.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const directTopicMatch = cleanQuestion.match(
    /^(?:what\s+(?:is|are)|define|meaning\s+of|what\s+does)\s+(?:a|an|the)?\s*(.+?)(?:\s+mean)?$/i
  );
  const directTopic = directTopicMatch?.[1]?.trim();

  if (directTopic) {
    return cleanQuestionTopic(directTopic);
  }

  const normalizedWords = cleanQuestion
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !answerFallbackStopWords.has(normalizeOption(word)));
  const topic = normalizedWords.slice(0, 6).join(' ');

  return cleanQuestionTopic(topic) || 'this topic';
}

function cleanQuestionTopic(topic: string) {
  return cleanStudentReadableText(topic)
    .replace(/[?!.]+$/g, '')
    .replace(/^(?:a|an|the|is|are|was|were|do|does|did|can|could|should|would|will)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function getStudyToolItemCount(tool: 'quiz' | 'flashcards', requestedCount?: number) {
  const fallbackCount = tool === 'quiz' ? quizItemCount : flashcardItemCount;

  if (!requestedCount || !Number.isFinite(requestedCount)) {
    return fallbackCount;
  }

  return Math.max(1, Math.min(maxQuizItemCount, Math.round(requestedCount)));
}

function getStudyToolGenerationBatchSize(
  tool: 'quiz' | 'flashcards',
  mode: StudyToolMode,
  itemCount: number
) {
  if (tool === 'quiz' && mode === 'mcq') {
    return Math.min(itemCount, 5);
  }

  if (tool === 'flashcards') {
    return Math.min(itemCount, 8);
  }

  return Math.min(itemCount, 6);
}

function extractLessonFacts(chunks: { text: string }[]): LessonFact[] {
  const facts = chunks
    .flatMap((chunk) => getLessonFactCandidates(chunk.text))
    .map(parseLessonFact)
    .filter((fact): fact is LessonFact => Boolean(fact));

  return uniqueFacts(facts);
}

function parseLessonFact(sentence: string): LessonFact | null {
  const cleanSentence = cleanChunkText(sentence);

  if (
    !isUsefulSentence(cleanSentence) ||
    isQuestionLikeText(cleanSentence) ||
    isNoisyLessonText(cleanSentence)
  ) {
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
  const normalizedTerm = normalizeOption(term);

  return (
    term.length >= 3 &&
    term.length <= 45 &&
    !term.includes(',') &&
    !term.includes('?') &&
    !isQuestionLikeTerm(term) &&
    !/\b(is|are|am|means|refers|called|enough|erased|first|level|pages|designed|absolute|beginner|everywhere|today)\b/i.test(term) &&
    !normalized.includes('question') &&
    !normalized.includes('answer') &&
    !normalized.includes('according') &&
    !normalized.includes('pdf') &&
    !normalized.includes('chapter') &&
    !normalized.includes('page') &&
    !normalized.includes('lesson detail') &&
    !isFunctionWordOnlyTerm(normalizedTerm) &&
    !genericStudyTerms.has(normalizedTerm) &&
    !/^\d+$/.test(normalized)
  );
}

function isUsefulFlashcardFact(fact: LessonFact) {
  const back = formatFactAnswer(fact);

  return (
    fact.kind === 'term' &&
    isUsefulTerm(fact.term) &&
    isUsefulFlashcardFront(fact.term) &&
    !isWeakQuizTerm(fact.term) &&
    isUsefulFlashcardBack(fact.term, back) &&
    isAnswerableFact(fact.term, fact.detail)
  );
}

function formatFactAnswer(fact: LessonFact, displayTerm = fact.term) {
  const rawDetail = fact.detail.replace(/_____+/g, displayTerm).trim();
  const detail = /^(is|are|was|were|means|refers|describes|uses|allows|helps|contains|includes|can)\b/i.test(rawDetail)
    ? `${displayTerm} ${rawDetail}`
    : rawDetail;

  return completeSentence(detail);
}

function isUsefulFlashcardFront(front: string) {
  const normalized = front.toLowerCase().replace(/[^a-z0-9#+]+/g, ' ').trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  const firstWord = words[0] ?? '';

  return (
    words.length >= 1 &&
    words.length <= 6 &&
    hasMeaningfulStudyTermWord(normalized) &&
    !isFunctionWordOnlyTerm(normalized) &&
    !isInstructionFragmentTerm(normalized) &&
    !isQuestionLikeText(front) &&
    !questionTermStarts.has(firstWord) &&
    (
      !flashcardFragmentStarts.has(firstWord) ||
      isAcceptedLeadingFunctionWordTerm(normalized)
    ) &&
    (
      !weakFlashcardFrontStarts.has(firstWord) ||
      isAcceptedLeadingFunctionWordTerm(normalized)
    ) &&
    !/\b(is|are|was|were|has|have|had|can|could|should|would|will)\b/i.test(front) &&
    !/[.!?]$/.test(front)
  );
}

function hasMeaningfulStudyTermWord(normalizedTerm: string) {
  return normalizedTerm
    .split(/\s+/)
    .filter(Boolean)
    .some((word) =>
      word.length > 2 &&
      !flashcardFrontStopWords.has(word)
    );
}

function isFunctionWordOnlyTerm(normalizedTerm: string) {
  const words = normalizedTerm.split(/\s+/).filter(Boolean);

  return (
    words.length === 0 ||
    words.every((word) => flashcardFrontStopWords.has(word))
  );
}

function isUsefulFlashcardBack(front: string, back: string) {
  const cleanBack = back.trim();

  return (
    isUsefulSentence(cleanBack) &&
    /^[A-Z0-9]/.test(cleanBack) &&
    !isQuestionLikeText(cleanBack) &&
    !/^(is|are|was|were|has|have|had|can|could|should|would|will)\b/i.test(cleanBack) &&
    !looksLikeSentenceContinuation(front, cleanBack) &&
    !normalizeOption(cleanBack).startsWith('this statement is true')
  );
}

function looksLikeSentenceContinuation(front: string, back: string) {
  const firstFrontWord = front.toLowerCase().replace(/[^a-z0-9#+]+/g, ' ').trim()
    .split(/\s+/)[0] ?? '';
  const cleanBack = back.trim();

  return (
    (
      flashcardFragmentStarts.has(firstFrontWord) &&
      !isAcceptedLeadingFunctionWordTerm(normalizeOption(front))
    ) ||
    cleanBack.length === 0 ||
    /^[a-z]/.test(cleanBack)
  );
}

function isAcceptedLeadingFunctionWordTerm(normalizedFront: string) {
  return /^(if statement|if clause|for loop|for statement|while loop|while statement|with statement|in operator)$/.test(normalizedFront);
}

function isAnswerableFact(term: string, detail: string) {
  const normalizedTerm = normalizeOption(term);
  const normalizedDetail = normalizeOption(detail);

  return (
    normalizedTerm.length > 0 &&
    normalizedDetail.length >= 20 &&
    !isQuestionLikeText(detail) &&
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

function isQuestionLikeTerm(term: string) {
  const normalized = normalizeOption(term);
  const words = normalized.split(/\s+/).filter(Boolean);

  return (
    words.length === 0 ||
    questionTermStarts.has(words[0]) ||
    /^(am i|are you|do i|does it|did it|can i|could i|should i|would i|will i)\b/.test(normalized)
  );
}

function isWeakQuizTerm(term: string) {
  const normalized = normalizeOption(term);
  const words = normalized.split(/\s+/).filter(Boolean);

  if (!normalized) {
    return true;
  }

  if (genericStudyTerms.has(normalized) || isFunctionWordOnlyTerm(normalized)) {
    return true;
  }

  if (isInstructionFragmentTerm(normalized)) {
    return true;
  }

  if (
    weakFlashcardFrontStarts.has(words[0] ?? '') &&
    !isAcceptedLeadingFunctionWordTerm(normalized)
  ) {
    return true;
  }

  if (words.length === 1 && weakSingleStudyWords.has(words[0])) {
    return true;
  }

  return words.length <= 2 && words.every((word) => weakSingleStudyWords.has(word));
}

function isInstructionFragmentTerm(normalizedTerm: string) {
  const words = normalizedTerm.split(/\s+/).filter(Boolean);

  return (
    words.length > 0 &&
    words.length <= 6 &&
    !isAcceptedLeadingFunctionWordTerm(normalizedTerm) &&
    isInstructionLikeStudyText(normalizedTerm)
  );
}

function hasWeakQuizFocus(question: string) {
  const focusTerm = extractQuizFocusTerm(question);

  return Boolean(focusTerm && isWeakQuizTerm(focusTerm));
}

function extractQuizFocusTerm(question: string) {
  const normalized = normalizeOption(question);
  const patterns = [
    /\babout\s+(.+?)(?:\s+(?:is|are|was|were|works|means|as used|in the lesson|in this topic)|$)/,
    /\binvolving\s+(.+?)(?:\s+(?:is|are|was|were|works|means|as used|in the lesson|in this topic)|$)/,
    /\bdefine\s+(.+?)(?:\s+(?:as used|in the lesson|in this topic)|$)/,
    /\bexplains?\s+(.+?)(?:\s+(?:as used|in the lesson|in this topic)|$)/,
    /\bmain role of\s+(.+?)(?:\s+(?:in|for|as)|$)/,
    /\bwhy is\s+(.+?)\s+important\b/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const focus = match?.[1]?.trim();

    if (focus) {
      return focus;
    }
  }

  return '';
}

function isQuestionLikeText(text: string) {
  const normalized = normalizeOption(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  const firstWord = words[0] ?? '';
  const secondWord = words[1] ?? '';

  if (!normalized) {
    return true;
  }

  if (/[?？]\s*$/.test(text.trim())) {
    return true;
  }

  if (!questionTermStarts.has(firstWord)) {
    return false;
  }

  if (questionAuxiliaryStarts.has(firstWord)) {
    return true;
  }

  return words.length <= 4 || questionAuxiliaryStarts.has(secondWord);
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
  'am',
  'chapter',
  'definition',
  'edition',
  'example',
  'here',
  'information',
  'lesson',
  'module',
  'page',
  'paragraph',
  'question',
  'section',
  'text',
  'this',
  'topic',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
]);

const weakSingleStudyWords = new Set([
  'activity',
  'answer',
  'below',
  'cards',
  'chapter',
  'common',
  'couple',
  'days',
  'detail',
  'due',
  'example',
  'exercise',
  'information',
  'lesson',
  'module',
  'page',
  'paragraph',
  'question',
  'section',
  'sentence',
  'something',
  'statement',
  'task',
  'text',
  'thing',
  'things',
  'topic',
  'weeks',
  'worksheet',
]);

const flashcardFrontStopWords = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'all',
  'also',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'during',
  'each',
  'few',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'many',
  'may',
  'more',
  'most',
  'much',
  'must',
  'my',
  'next',
  'no',
  'not',
  'now',
  'of',
  'on',
  'only',
  'or',
  'other',
  'our',
  'over',
  'own',
  'same',
  'several',
  'she',
  'should',
  'so',
  'some',
  'something',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'us',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

const weakFlashcardFrontStarts = new Set([
  ...flashcardFrontStopWords,
  'activity',
  'answer',
  'example',
  'exercise',
  'information',
  'lesson',
  'more',
  'page',
  'question',
  'sentence',
  'text',
  'worksheet',
]);

const quizOptionStopWords = new Set([
  'about',
  'according',
  'answer',
  'because',
  'chapter',
  'choice',
  'detail',
  'does',
  'from',
  'idea',
  'lesson',
  'main',
  'meaning',
  'option',
  'point',
  'question',
  'says',
  'statement',
  'that',
  'the',
  'this',
  'topic',
  'what',
  'which',
  'with',
]);

const answerFallbackStopWords = new Set([
  'a',
  'an',
  'about',
  'after',
  'again',
  'answer',
  'are',
  'based',
  'because',
  'before',
  'book',
  'can',
  'could',
  'does',
  'explain',
  'from',
  'give',
  'have',
  'help',
  'how',
  'does',
  'do',
  'to',
  'into',
  'is',
  'lesson',
  'like',
  'list',
  'make',
  'mean',
  'need',
  'please',
  'question',
  'should',
  'source',
  'that',
  'the',
  'their',
  'there',
  'these',
  'this',
  'what',
  'when',
  'where',
  'which',
  'why',
  'with',
  'work',
  'works',
  'effectively',
  'would',
  'your',
]);

const questionTermStarts = new Set([
  'am',
  'are',
  'can',
  'could',
  'did',
  'do',
  'does',
  'had',
  'has',
  'have',
  'how',
  'is',
  'should',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'would',
]);

const questionAuxiliaryStarts = new Set([
  'am',
  'are',
  'can',
  'could',
  'did',
  'do',
  'does',
  'had',
  'has',
  'have',
  'is',
  'should',
  'was',
  'were',
  'will',
  'would',
]);

const flashcardFragmentStarts = new Set([
  'also',
  'although',
  'and',
  'as',
  'after',
  'at',
  'before',
  'because',
  'but',
  'by',
  'during',
  'for',
  'from',
  'in',
  'if',
  'it',
  'its',
  'of',
  'on',
  'or',
  'over',
  'since',
  'so',
  'that',
  'then',
  'there',
  'these',
  'they',
  'this',
  'though',
  'through',
  'to',
  'under',
  'using',
  'when',
  'where',
  'while',
  'with',
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
  ]).filter((candidate) =>
    !isQuestionLikeText(candidate) &&
    !isNoisyLessonText(candidate)
  );
}

function isUsefulSentence(sentence: string) {
  const cleanSentence = cleanLessonText(sentence);
  const words = cleanSentence.split(/\s+/).filter(Boolean);

  return (
    cleanSentence.length >= 24 &&
    cleanSentence.length <= 260 &&
    words.length >= 4 &&
    !isQuestionLikeText(cleanSentence) &&
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
    isInstructionLikeStudyText(text) ||
    normalized.includes('table of contents') ||
    normalized.includes('first edition') ||
    normalized.includes('level beginner') ||
    normalized.includes('no prior knowledge') ||
    normalized.includes('designed for absolute beginners') ||
    normalized.includes('according to the pdf') ||
    normalized.includes('uploaded pdf')
  );
}

function isInstructionLikeStudyText(text: string) {
  const normalized = normalizeOption(text);

  if (!normalized) {
    return false;
  }

  return (
    /^(answer|choose|circle|complete|consider|draw|explain|fill|find|identify|list|look|make|read|select|solve|try|write)\b/.test(normalized) ||
    /\b(answer the|choose the|circle the|complete the|fill in|keep (?:the|your)|look at|make up|select the|test your|try making|try to|write down)\b/.test(normalized)
  );
}
