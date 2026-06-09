import {
  cacheDirectory,
  deleteAsync,
  getInfoAsync,
} from 'expo-file-system/legacy';
import * as Device from 'expo-device';
import {
  models,
  MULTI_QA_MINILM_L6_COS_V1,
  ResourceFetcherUtils,
} from 'react-native-executorch';
import { ExpoResourceFetcher } from 'react-native-executorch-expo-resource-fetcher';

export const modelDownloadedKey = 'offline_ai_model_downloaded';
export const modelDownloadInProgressKey = 'offline_ai_model_download_in_progress';
export const modelProfileKey = 'offline_ai_model_profile';
export const embeddingModelName = 'multi-qa-minilm-l6-cos-v1';

export const offlineLlmModel = models.llm.qwen2_5_3b({ quant: true });
export const offlineEmbeddingModel = MULTI_QA_MINILM_L6_COS_V1;
export const offlineModelProfile = offlineLlmModel.modelName;
export const minimumRecommendedMemoryBytes = 6 * 1024 ** 3;

const previousAlabLlmModels = [
  models.llm.qwen2_5_0_5b({ quant: true }),
  models.llm.qwen2_5_1_5b({ quant: true }),
  models.llm.qwen2_5_3b({ quant: true }),
];

const allAlabModelSources = [
  ...previousAlabLlmModels.flatMap((model) => [
    model.modelSource,
    model.tokenizerSource,
    model.tokenizerConfigSource,
  ]),
  offlineEmbeddingModel.modelSource,
  offlineEmbeddingModel.tokenizerSource,
];

export function getOfflineModelDeviceWarning() {
  const architectures = Device.supportedCpuArchitectures ?? [];
  const hasArm64 = architectures.some((architecture) =>
    architecture.toLowerCase().includes('arm64')
  );

  if (architectures.length > 0 && !hasArm64) {
    return 'This study helper needs a 64-bit Android device.';
  }

  if (
    Device.totalMemory &&
    Device.totalMemory < minimumRecommendedMemoryBytes
  ) {
    return 'This phone may not have enough memory for the larger study helper. Use a stronger Android device or switch back to the lighter model.';
  }

  return null;
}

export async function deleteOfflineModelResources() {
  try {
    await ExpoResourceFetcher.deleteResources(...allAlabModelSources);
  } catch {
    // A missing or locked model file should not block the recovery flow.
  }

  await Promise.all(allAlabModelSources.map(deleteCacheResource));
}

async function deleteCacheResource(source: string | number | object) {
  if (typeof source !== 'string' || !cacheDirectory) {
    return;
  }

  const filename = ResourceFetcherUtils.getFilenameFromUri(source);
  const cacheUri = `${cacheDirectory}${filename}`;

  try {
    const fileInfo = await getInfoAsync(cacheUri);

    if (fileInfo.exists) {
      await deleteAsync(cacheUri, { idempotent: true });
    }
  } catch {
    // Best-effort cleanup; the next download still starts from trusted markers.
  }
}
