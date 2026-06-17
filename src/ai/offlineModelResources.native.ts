import * as Device from 'expo-device';
import {
  cacheDirectory,
  deleteAsync,
  getInfoAsync,
} from 'expo-file-system/legacy';
import {
  models,
  MULTI_QA_MINILM_L6_COS_V1,
  ResourceFetcherUtils,
} from 'react-native-executorch';
import type { ResourceSource } from 'react-native-executorch';
import { ExpoResourceFetcher } from 'react-native-executorch-expo-resource-fetcher';

export const modelDownloadedKey = 'offline_ai_model_downloaded';
export const modelDownloadInProgressKey = 'offline_ai_model_download_in_progress';
export const modelProfileKey = 'offline_ai_model_profile';
const embeddingResourceName = 'distiluse-base-multilingual-cased-v2-8da4w';
export const embeddingModelName = `${embeddingResourceName}-chunk100-noprefix-v2`;

export const offlineLlmModel = models.llm.qwen2_5_1_5b({ quant: true });
export const offlineEmbeddingModel =
  models.text_embedding.distiluse_base_multilingual_cased_v2();
export const offlineModelProfile = `${offlineLlmModel.modelName}+${embeddingResourceName}`;
export const minimumRecommendedMemoryBytes = 4 * 1024 ** 3;
export const offlineModelResources: {
  label: string;
  source: ResourceSource;
}[] = [
  { label: 'answer helper model', source: offlineLlmModel.modelSource },
  { label: 'answer helper tokenizer', source: offlineLlmModel.tokenizerSource },
  { label: 'answer helper settings', source: offlineLlmModel.tokenizerConfigSource },
  { label: 'lesson search model', source: offlineEmbeddingModel.modelSource },
  { label: 'lesson search tokenizer', source: offlineEmbeddingModel.tokenizerSource },
];

export function formatEmbeddingInput(
  text: string,
  _kind: 'query' | 'passage'
) {
  return text.replace(/\s+/g, ' ').trim();
}

const previousAlabLlmModels = [
  models.llm.qwen2_5_0_5b({ quant: true }),
  models.llm.qwen2_5_1_5b({ quant: true }),
  models.llm.qwen2_5_3b({ quant: true }),
];

const previousAlabEmbeddingModels = [
  MULTI_QA_MINILM_L6_COS_V1,
];

const allAlabModelSources = [
  ...previousAlabLlmModels.flatMap((model) => [
    model.modelSource,
    model.tokenizerSource,
    model.tokenizerConfigSource,
  ]),
  ...previousAlabEmbeddingModels.flatMap((model) => [
    model.modelSource,
    model.tokenizerSource,
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
    return 'This device or emulator may not have enough RAM for the study helper. Use an Android device or emulator with at least 4 GB RAM';
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

export async function downloadOfflineModelResources(
  onProgress: (status: {
    label: string;
    overallProgress: number;
    resourceIndex: number;
    resourceProgress: number;
    totalResources: number;
  }) => void
) {
  const totalResources = offlineModelResources.length;

  for (const [index, resource] of offlineModelResources.entries()) {
    const resourceIndex = index + 1;

    onProgress({
      label: resource.label,
      overallProgress: index / totalResources,
      resourceIndex,
      resourceProgress: 0,
      totalResources,
    });

    await ExpoResourceFetcher.fetch((resourceProgress) => {
      onProgress({
        label: resource.label,
        overallProgress: (index + resourceProgress) / totalResources,
        resourceIndex,
        resourceProgress,
        totalResources,
      });
    }, resource.source);

    onProgress({
      label: resource.label,
      overallProgress: resourceIndex / totalResources,
      resourceIndex,
      resourceProgress: 1,
      totalResources,
    });
  }
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
