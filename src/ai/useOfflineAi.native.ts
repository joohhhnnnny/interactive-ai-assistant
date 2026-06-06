import { useCallback, useEffect, useState } from 'react';
import {
  isAvailable,
  Message,
  models,
  MULTI_QA_MINILM_L6_COS_V1,
  useLLM,
  useTextEmbeddings,
} from 'react-native-executorch';
import { getAppSetting, hasReadySources } from '../data/database';
import {
  buildGroundedMessages,
  buildStudyToolMessages,
  formatSourceLabel,
  retrieveRelevantChunks,
} from './retrieval';

type OfflineAiResponse = {
  text: string;
  sources: string[];
};

const modelDownloadedKey = 'offline_ai_model_downloaded';
const embeddingModelName = 'multi-qa-minilm-l6-cos-v1';

export function useOfflineAi(bookId: string, bookTitle: string) {
  const [shouldLoadModel, setShouldLoadModel] = useState(false);
  const llm = useLLM({
    model: models.llm.qwen2_5_0_5b({ quant: true }),
    preventLoad: !shouldLoadModel,
  });
  const embeddings = useTextEmbeddings({
    model: MULTI_QA_MINILM_L6_COS_V1,
    preventLoad: !shouldLoadModel,
  });

  useEffect(() => {
    let isActive = true;

    getAppSetting(modelDownloadedKey).then((value) => {
      if (isActive && value === 'true') {
        setShouldLoadModel(true);
      }
    });

    return () => {
      isActive = false;
    };
  }, []);

  const answerQuestion = useCallback(
    async (question: string): Promise<OfflineAiResponse> => {
      if (!isAvailable) {
        return {
          text: 'The study helper is not available on this device yet.',
          sources: [],
        };
      }

      if (!shouldLoadModel) {
        return {
          text: 'Please prepare the study helper from My Books first.',
          sources: [],
        };
      }

      const hasSources = await hasReadySources(bookId);

      if (!hasSources) {
        return {
          text: 'I need a ready source before I can answer from this book.',
          sources: [],
        };
      }

      let queryEmbedding: Float32Array | null = null;

      if (embeddings.isReady) {
        queryEmbedding = await embeddings.forward(question);
      }

      const chunks = await retrieveRelevantChunks(bookId, question, queryEmbedding);

      if (chunks.length === 0) {
        return {
          text: 'The lesson material does not provide enough information for that question yet.',
          sources: [],
        };
      }

      if (!llm.isReady) {
        const progress = Math.round(llm.downloadProgress * 100);
        return {
          text: `I found your lesson, but the study helper is still getting ready${progress > 0 ? ` (${progress}%)` : ''}.`,
          sources: chunks.map(formatSourceLabel),
        };
      }

      const answer = await llm.generate(
        buildGroundedMessages(question, chunks) as Message[]
      );

      return {
        text: answer.trim(),
        sources: chunks.map(formatSourceLabel),
      };
    },
    [bookId, embeddings, llm, shouldLoadModel]
  );

  const generateStudyTool = useCallback(
    async (tool: 'quiz' | 'flashcards'): Promise<OfflineAiResponse> => {
      if (!llm.isReady) {
        return {
          text: shouldLoadModel
            ? 'The study helper is still getting ready.'
            : 'Please prepare the study helper from My Books first.',
          sources: [],
        };
      }

      const query =
        tool === 'quiz'
          ? `important quiz topics from ${bookTitle}`
          : `key terms and concepts from ${bookTitle}`;
      const queryEmbedding = embeddings.isReady
        ? await embeddings.forward(query)
        : null;
      const chunks = await retrieveRelevantChunks(bookId, query, queryEmbedding);

      if (chunks.length === 0) {
        return {
          text: 'I need processed lesson chunks before I can generate this study tool.',
          sources: [],
        };
      }

      const response = await llm.generate(
        buildStudyToolMessages(tool, bookTitle, chunks) as Message[]
      );

      return {
        text: response.trim(),
        sources: chunks.map(formatSourceLabel),
      };
    },
    [bookId, bookTitle, embeddings, llm, shouldLoadModel]
  );

  const embedLessonText = useCallback(
    async (text: string): Promise<Float32Array | null> => {
      if (!shouldLoadModel || !embeddings.isReady) {
        return null;
      }

      return embeddings.forward(text);
    },
    [embeddings, shouldLoadModel]
  );

  return {
    answerQuestion,
    generateStudyTool,
    embedLessonText,
    embeddingModelName,
    isAvailable,
    isModelReady: llm.isReady,
    isEmbeddingReady: embeddings.isReady,
    isGenerating: llm.isGenerating,
    llmDownloadProgress: llm.downloadProgress,
    embeddingDownloadProgress: embeddings.downloadProgress,
    error: llm.error ?? embeddings.error,
  };
}
