type OfflineAiResponse = {
  text: string;
  sources: string[];
};

export function useOfflineAi() {
  const answerQuestion = async (): Promise<OfflineAiResponse> => ({
    text: 'The study helper is not available in this preview yet.',
    sources: [],
  });

  const generateStudyTool = async (
    _tool?: 'quiz' | 'flashcards',
    _mode?: 'mcq' | 'fill_blank' | 'essay'
  ): Promise<OfflineAiResponse> => ({
    text: 'Quizzes and flashcards are not available in this preview yet.',
    sources: [],
  });

  const embedLessonText = async (): Promise<Float32Array | null> => null;

  return {
    answerQuestion,
    generateStudyTool,
    embedLessonText,
    embeddingModelName: 'multi-qa-minilm-l6-cos-v1',
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
