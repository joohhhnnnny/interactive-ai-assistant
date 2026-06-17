type OfflineAiResponse = {
  text: string;
  sources: string[];
  answerMode: 'general' | 'grounded' | 'summary' | 'study_tool' | 'status';
  confidence?: 'none' | 'low' | 'medium' | 'high';
  metrics?: {
    retrievalMs?: number;
    generationMs?: number;
    totalMs?: number;
    sourceCount?: number;
    topScore?: number | null;
    fallbackReason?: string | null;
  };
};

export function useOfflineAi() {
  const answerQuestion = async (): Promise<OfflineAiResponse> => ({
    text: 'The study helper is not available in this preview yet.',
    sources: [],
    answerMode: 'status',
    confidence: 'none',
  });

  const generateStudyTool = async (
    _tool?: 'quiz' | 'flashcards',
    _mode?: 'mcq' | 'fill_blank' | 'essay',
    _requestedCount?: number
  ): Promise<OfflineAiResponse> => ({
    text: 'Quizzes and flashcards are not available in this preview yet.',
    sources: [],
    answerMode: 'status',
    confidence: 'none',
  });

  const embedLessonText = async (): Promise<Float32Array | null> => null;

  return {
    answerQuestion,
    generateStudyTool,
    embedLessonText,
    embeddingModelName: 'distiluse-base-multilingual-cased-v2-8da4w-chunk100-noprefix-v2',
    isAvailable: false,
    hasCheckedDownload: true,
    shouldLoadModel: false,
    isModelReady: false,
    isEmbeddingReady: false,
    isGenerating: false,
    llmDownloadProgress: 0,
    embeddingDownloadProgress: 0,
    error: null,
  };
}
