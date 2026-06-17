import {
  replaceSourceChunks,
  replaceSourcePages,
  upsertSourceProcessingJob,
} from '../data/database';
import type { SourceProcessingStatus } from '../data/database';

const extractionBlockedMessage =
  'PDF text extraction is unavailable in this runtime. Use the Android app build with the native PDF extractor installed.';

export type SourceProcessingProgress = {
  phase: 'starting' | 'extracting' | 'chunking' | 'embedding' | 'complete';
  message: string;
  percent: number;
  current?: number;
  total?: number;
};

export async function processSourcePdfPlaceholder(
  sourceId: string,
  _fileUri?: string,
  options?: {
    embedText: (text: string) => Promise<ArrayLike<number> | null>;
    modelName: string;
    onStatusChange?: (status: SourceProcessingStatus) => void;
    onProgress?: (progress: SourceProcessingProgress) => void;
  }
) {
  const setStatus = async (status: SourceProcessingStatus, error?: string) => {
    options?.onStatusChange?.(status);
    await upsertSourceProcessingJob(sourceId, status, error);
  };

  options?.onProgress?.({
    phase: 'extracting',
    message: 'Checking PDF reader support...',
    percent: 5,
  });
  await setStatus('extracting');
  await replaceSourcePages(sourceId, []);
  options?.onProgress?.({
    phase: 'chunking',
    message: 'PDF text extraction is unavailable here.',
    percent: 25,
  });
  await setStatus('chunking');
  await replaceSourceChunks(sourceId, []);
  await setStatus('failed', extractionBlockedMessage);
}
