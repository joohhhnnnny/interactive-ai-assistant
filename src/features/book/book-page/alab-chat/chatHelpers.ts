import { StoredChatMessage } from '../../../../data/database';
import { ChatMessage, OfflineAi } from '../types';

export type StudyToolIntent = {
  tool: 'quiz' | 'flashcards';
  mode?: 'mcq' | 'fill_blank' | 'essay';
  count?: number;
};

type ComposerSpeechState = {
  isListening: boolean;
  isTranscribing: boolean;
};

export function mapStoredChatMessage(message: StoredChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    sources: message.sources,
    kind: message.kind,
  };
}

export function formatAnalysisDuration(durationMs: number) {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function getComposerPlaceholder(offlineSpeech: ComposerSpeechState) {
  if (offlineSpeech.isListening) {
    return 'Listening...';
  }

  if (offlineSpeech.isTranscribing) {
    return 'Preparing your question...';
  }

  return 'Ask a Question or Create Something...';
}

export function getStudyToolIntent(question: string): StudyToolIntent | null {
  const normalized = question.toLowerCase();
  const requestedCount = getRequestedStudyItemCount(normalized);

  if (normalized.includes('quiz')) {
    if (
      normalized.includes('fill in') ||
      normalized.includes('fill-in') ||
      normalized.includes('blank')
    ) {
      return { tool: 'quiz', mode: 'fill_blank', count: requestedCount };
    }

    if (
      normalized.includes('essay') ||
      normalized.includes('explain') ||
      normalized.includes('open ended') ||
      normalized.includes('open-ended')
    ) {
      return { tool: 'quiz', mode: 'essay', count: requestedCount };
    }

    return { tool: 'quiz', mode: 'mcq', count: requestedCount };
  }

  if (
    normalized.includes('flashcard') ||
    normalized.includes('flash card') ||
    normalized.includes('review card')
  ) {
    return { tool: 'flashcards', count: requestedCount };
  }

  return null;
}

function getRequestedStudyItemCount(text: string) {
  const countMatch = text.match(/\b(\d{1,2})\s*(?:items?|questions?|quiz|flashcards?|review\s+cards?)\b/);
  const rawCount = countMatch ? Number(countMatch[1]) : NaN;

  if (!Number.isFinite(rawCount)) {
    return undefined;
  }

  return Math.max(1, Math.min(50, rawCount));
}

export function formatAiStatus(offlineAi: OfflineAi) {
  if (!offlineAi.isAvailable) {
    return 'The study helper is not available in this preview yet.';
  }

  if (offlineAi.error) {
    return 'The study helper could not start on this device.';
  }

  if (!offlineAi.isModelReady) {
    const progress = Math.round(offlineAi.llmDownloadProgress * 100);
    return `The study helper is getting ready${progress > 0 ? ` (${progress}%)` : ''}.`;
  }

  if (!offlineAi.isEmbeddingReady) {
    const progress = Math.round(offlineAi.embeddingDownloadProgress * 100);
    return `Lesson search is getting ready${progress > 0 ? ` (${progress}%)` : ''}.`;
  }

  return 'Ready to study from your sources.';
}
