import {
  replaceSourceChunks,
  replaceSourcePages,
  upsertSourceProcessingJob,
} from '../data/database';
import type { SourceProcessingStatus } from '../data/database';

const extractionBlockedMessage =
  'Saved. ALAB needs the Android app build to read this PDF.';

export async function processSourcePdfPlaceholder(
  sourceId: string,
  _fileUri?: string,
  options?: {
    embedText: (text: string) => Promise<ArrayLike<number> | null>;
    modelName: string;
    onStatusChange?: (status: SourceProcessingStatus) => void;
  }
) {
  const setStatus = async (status: SourceProcessingStatus, error?: string) => {
    options?.onStatusChange?.(status);
    await upsertSourceProcessingJob(sourceId, status, error);
  };

  await setStatus('extracting');
  await replaceSourcePages(sourceId, []);
  await setStatus('chunking');
  await replaceSourceChunks(sourceId, []);
  await setStatus('failed', extractionBlockedMessage);
}
