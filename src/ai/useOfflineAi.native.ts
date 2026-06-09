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
import {
  embeddingModelName,
  modelDownloadedKey,
  modelProfileKey,
  offlineEmbeddingModel,
  offlineLlmModel,
  offlineModelProfile,
} from './offlineModelResources.native';

type OfflineAiResponse = {
  text: string;
  sources: string[];
};

export type StudyToolMode = 'mcq' | 'fill_blank' | 'essay';

const heavyAnswerTimeoutMs = 30000;
const quizItemCount = 10;
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

      if (!shouldLoadEmbeddings) {
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

      if (llm.error) {
        return {
          text: 'The larger study helper had trouble opening on this device. Please close other apps and try again, or switch back to the lighter study helper.',
          sources: chunks.map(formatSourceLabel),
        };
      }

      if (!shouldLoadLlm) {
        setShouldLoadLlm(true);
        return {
          text: 'I found your lesson. The larger study helper is opening now, so please ask again in a moment.',
          sources: chunks.map(formatSourceLabel),
        };
      }

      if (!llm.isReady) {
        const progress = Math.round(llm.downloadProgress * 100);
        return {
          text: `I found your lesson, but the study helper is still getting ready${progress > 0 ? ` (${progress}%)` : ''}.`,
          sources: chunks.map(formatSourceLabel),
        };
      }

      llm.configure({ generationConfig });

      const answer = await withTimeout(
        llm.generate(buildGroundedMessages(question, chunks) as Message[]),
        heavyAnswerTimeoutMs,
        '',
        llm.interrupt
      );

      const cleanAnswer = answer.trim();

      return {
        text: cleanAnswer && !isBadGroundedAnswer(cleanAnswer)
          ? cleanAnswer
          : buildQuickGroundedAnswer(chunks),
        sources: chunks.map(formatSourceLabel),
      };
    },
    [bookId, embeddings, hasCheckedDownload, llm, shouldLoadEmbeddings, shouldLoadLlm]
  );

  const generateStudyTool = useCallback(
    async (
      tool: 'quiz' | 'flashcards',
      mode: StudyToolMode = 'mcq'
    ): Promise<OfflineAiResponse> => {
      if (!hasCheckedDownload) {
        return {
          text: 'Checking your saved study helper...',
          sources: [],
        };
      }

      if (!shouldLoadEmbeddings) {
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
          ? `${mode} quiz topics from ${bookTitle}`
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

      const toolText = buildSimpleStudyToolFallback(tool, chunks, mode);

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
    [bookId, bookTitle, embeddings, hasCheckedDownload, shouldLoadEmbeddings]
  );

  const embedLessonText = useCallback(
    async (text: string): Promise<Float32Array | null> => {
      if (!shouldLoadEmbeddings || !embeddings.isReady) {
        return null;
      }

      return embeddings.forward(text);
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

type LessonFact = {
  term: string;
  detail: string;
  sourceText: string;
};

function buildSimpleStudyToolFallback(
  tool: 'quiz' | 'flashcards',
  chunks: { text: string }[],
  mode: StudyToolMode = 'mcq'
) {
  const facts = extractLessonFacts(chunks);
  const sentences = facts.length > 0
    ? facts.map((fact) => fact.sourceText)
    : uniqueTexts(splitSentences(chunks));
  const baseSnippets = sentences.length > 0
    ? sentences
    : chunks.map((chunk) => cleanChunkText(chunk.text)).filter(Boolean);
  const targetCount = tool === 'quiz' ? quizItemCount : flashcardItemCount;
  const repeatedFacts = repeatToCount(
    facts.length > 0 ? facts : buildFactsFromSnippets(baseSnippets),
    targetCount
  );

  if (tool === 'flashcards') {
    return repeatedFacts
      .map((fact) =>
        [
          `Front: ${fact.term}`,
          `Back: ${shortText(fact.detail, 240)}`,
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

function repeatToCount<T>(items: T[], count: number) {
  if (items.length === 0) {
    return [];
  }

  return Array.from({ length: count }, (_, index) => items[index % items.length]);
}

function extractLessonFacts(chunks: { text: string }[]): LessonFact[] {
  const facts = splitSentences(chunks)
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

    if (isUsefulTerm(rawTerm) && detail.length >= 18) {
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
    term
      .replace(/^\W+|\W+$/g, '')
      .replace(/^(the|a|an)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function cleanStudyDetail(detail: string, term: string) {
  return detail
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
      `Explanation: ${fact.term}: ${shortText(fact.detail.replace(/_____+/g, fact.term), 180)}`,
    ].join('\n');
  }

  if (mode === 'essay') {
    return [
      `Question: Explain ${fact.term} in your own words. Include why it matters in the lesson.`,
      `Answer: ${fact.term}: ${shortText(fact.detail.replace(/_____+/g, fact.term), 220)}`,
      `Explanation: Use the lesson idea, then add one clear example.`,
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
    `Explanation: ${fact.term}: ${shortText(fact.detail.replace(/_____+/g, fact.term), 180)}`,
  ].join('\n');
}

function buildDefinitionQuestion(fact: LessonFact) {
  const detail = fact.detail.replace(/_____+/g, 'it');
  const prompt = detail.charAt(0).toUpperCase() + detail.slice(1);

  return `${shortText(prompt, 150)} What is being described?`;
}

function buildFillBlankQuestion(fact: LessonFact) {
  if (fact.detail.includes('_____')) {
    return shortText(fact.detail, 170);
  }

  return `_____ ${shortText(fact.detail, 155)}`;
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
