import { useCallback, useEffect, useState } from 'react';
import {
  isAvailable,
  Message,
  models,
  MULTI_QA_MINILM_L6_COS_V1,
  useLLM,
  useTextEmbeddings,
} from 'react-native-executorch';
import {
  getAppSetting,
  hasReadySources,
  hasReadyStudyChunks,
  saveGeneratedFlashcards,
  saveGeneratedQuiz,
} from '../data/database';
import {
  buildGroundedMessages,
  formatSourceLabel,
  retrieveBookOverviewChunks,
  retrieveRelevantChunks,
  retrieveStudyToolChunks,
} from './retrieval';

type OfflineAiResponse = {
  text: string;
  sources: string[];
};

const modelDownloadedKey = 'offline_ai_model_downloaded';
const embeddingModelName = 'multi-qa-minilm-l6-cos-v1';
const answerTimeoutMs = 18000;
const quizItemCount = 10;
const flashcardItemCount = 20;

export function useOfflineAi(bookId: string, bookTitle: string) {
  const [shouldLoadModel, setShouldLoadModel] = useState(false);
  const [hasCheckedDownload, setHasCheckedDownload] = useState(false);
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
      if (!isAvailable) {
        return {
          text: 'The study helper is not available on this device yet.',
          sources: [],
        };
      }

      if (!hasCheckedDownload) {
        return {
          text: 'Checking your saved study helper...',
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

      if (isSummaryRequest(question)) {
        const chunks = await retrieveBookOverviewChunks(bookId, 12);

        if (chunks.length === 0) {
          return {
            text: 'I could not find readable PDF text to summarize yet.',
            sources: [],
          };
        }

        return {
          text: buildPdfSummary(chunks),
          sources: chunks.slice(0, 5).map(formatSourceLabel),
        };
      }

      let queryEmbedding: Float32Array | null = null;

      if (embeddings.isReady) {
        queryEmbedding = await embeddings.forward(question);
      }

      const chunks = await retrieveRelevantChunks(bookId, question, queryEmbedding);

      if (chunks.length === 0) {
        return {
          text: 'I could not find that in your uploaded PDFs. Please ask about the lesson sources in this book.',
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

      const answer = await withTimeout(
        llm.generate(buildGroundedMessages(question, chunks) as Message[]),
        answerTimeoutMs,
        ''
      );

      const cleanAnswer = answer.trim();

      return {
        text: cleanAnswer && !isBadGroundedAnswer(cleanAnswer)
          ? cleanAnswer
          : buildQuickGroundedAnswer(chunks),
        sources: chunks.map(formatSourceLabel),
      };
    },
    [bookId, embeddings, hasCheckedDownload, llm, shouldLoadModel]
  );

  const generateStudyTool = useCallback(
    async (tool: 'quiz' | 'flashcards'): Promise<OfflineAiResponse> => {
      if (!hasCheckedDownload) {
        return {
          text: 'Checking your saved study helper...',
          sources: [],
        };
      }

      if (!shouldLoadModel) {
        return {
          text: 'Please prepare the study helper from My Books first.',
          sources: [],
        };
      }

      const hasChunks = await hasReadyStudyChunks(bookId);

      if (!hasChunks) {
        return {
          text: 'ALAB needs a ready source before making this study tool.',
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
      const chunks = await retrieveStudyToolChunks(
        bookId,
        queryEmbedding,
        tool === 'quiz' ? quizItemCount : flashcardItemCount
      );

      if (chunks.length === 0) {
        return {
          text: 'ALAB needs a ready source before making this study tool.',
          sources: [],
        };
      }

      const toolText = buildSimpleStudyToolFallback(tool, chunks);

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

      return {
        text: toolText,
        sources: chunks.map(formatSourceLabel),
      };
    },
    [bookId, bookTitle, embeddings, hasCheckedDownload, shouldLoadModel]
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
    hasCheckedDownload,
    shouldLoadModel,
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
  fallback: T
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);

    promise
      .then((value) => resolve(value))
      .catch(() => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}

function buildQuickGroundedAnswer(chunks: { text: string }[]) {
  const bestSnippet = chunks
    .map((chunk) => chunk.text.replace(/\s+/g, ' ').trim())
    .find(Boolean);

  if (!bestSnippet) {
    return 'I found a related part in your PDF, but I could not prepare a full answer yet. Please try asking in a simpler way.';
  }

  return `I found this in your PDF: ${bestSnippet.slice(0, 420)}${bestSnippet.length > 420 ? '...' : ''}`;
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

function cleanChunkText(text: string) {
  return text
    .replace(/#{1,6}\s*/g, '')
    .replace(/\bPage\s+\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(chunks: { text: string }[]) {
  return chunks
    .flatMap((chunk) =>
      cleanChunkText(chunk.text)
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
    )
    .filter((sentence) => sentence.length >= 35 && sentence.length <= 240);
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
  const bullets = uniqueTexts(sentences)
    .slice(0, 6)
    .map((sentence) => `- ${shortText(sentence, 180)}`);

  if (bullets.length === 0) {
    return `Here is a quick summary of your PDF:\n- ${shortText(chunks[0]?.text ?? '', 220)}`;
  }

  return [
    'Here is a quick summary of your PDF:',
    ...bullets,
  ].join('\n');
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
    .filter((word) => word.length > 3)
    .slice(0, 5);

  if (words.length >= 2) {
    return words.slice(0, 3).join(' ');
  }

  return `lesson detail ${fallbackIndex + 1}`;
}

function buildSimpleStudyToolFallback(
  tool: 'quiz' | 'flashcards',
  chunks: { text: string }[]
) {
  const sentences = uniqueTexts(splitSentences(chunks));
  const baseSnippets = (sentences.length > 0
    ? sentences
    : chunks.map((chunk) => cleanChunkText(chunk.text)).filter(Boolean)
  );
  const targetCount = tool === 'quiz' ? quizItemCount : flashcardItemCount;
  const snippets = repeatToCount(baseSnippets, targetCount);

  if (tool === 'flashcards') {
    return snippets
      .map((snippet, index) =>
        [
          `Front: What should you remember about ${getKeyPhrase(snippet, index)}?`,
          `Back: ${shortText(snippet, 240)}`,
        ].join('\n')
      )
      .join('\n\n');
  }

  return snippets
    .map((snippet, index) =>
      buildFallbackQuizQuestion(snippet, snippets, index)
    )
    .join('\n\n');
}

function repeatToCount(items: string[], count: number) {
  if (items.length === 0) {
    return [];
  }

  return Array.from({ length: count }, (_, index) => items[index % items.length]);
}

function buildFallbackQuizQuestion(
  snippet: string,
  allSnippets: string[],
  index: number
) {
  const correct = shortText(snippet, 150);
  const wrongOptions = allSnippets
    .filter((item) => item !== snippet)
    .slice(index, index + 3)
    .map((item) => shortText(item, 120));
  const options = [
    correct,
    wrongOptions[0] ?? 'It is not discussed in the uploaded PDF.',
    wrongOptions[1] ?? 'The PDF gives no detail about this topic.',
    wrongOptions[2] ?? 'This is unrelated to the lesson source.',
  ];

  return [
    `Question: According to the PDF, which statement about ${getKeyPhrase(snippet, index)} is correct?`,
    `A. ${options[0]}`,
    `B. ${options[1]}`,
    `C. ${options[2]}`,
    `D. ${options[3]}`,
    `Correct answer: A. ${options[0]}`,
    `Explanation: ${shortText(snippet, 180)}`,
  ].join('\n');
}
