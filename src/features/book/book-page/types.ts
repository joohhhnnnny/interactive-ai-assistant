import { useOfflineAi } from '../../../ai/useOfflineAi';

export type OfflineAi = ReturnType<typeof useOfflineAi>;

export type PendingChatPrompt = {
  id: number;
  text: string;
};

export type StudyReadiness = {
  isChecking: boolean;
  hasReadyChunks: boolean;
  hasProcessingSources: boolean;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'ai';
  text: string;
  sources?: string[];
  analysisText?: string;
  kind?: 'answer' | 'quiz' | 'flashcards' | 'status';
};
