import { StoredChatMessage } from '../../../../data/database';
import { ChatMessage, OfflineAi } from '../types';

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

export function getVisibleSources(message: ChatMessage) {
  if (
    message.role !== 'ai' ||
    message.kind === 'status' ||
    !message.sources ||
    message.sources.length === 0
  ) {
    return [];
  }

  const insufficientAnswer = message.text.toLowerCase();

  if (
    insufficientAnswer.includes('does not provide enough information') ||
    insufficientAnswer.includes('not available in this preview') ||
    insufficientAnswer.includes('not available on this device') ||
    insufficientAnswer.includes('please prepare the study helper')
  ) {
    return [];
  }

  return Array.from(new Set(message.sources)).filter((source) => {
    const cleanSource = source.trim();
    return cleanSource.length > 0 && cleanSource.toLowerCase() !== 'unknown source';
  });
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
