import { useEffect, useState } from 'react';
import {
  isAvailable,
  models,
  MULTI_QA_MINILM_L6_COS_V1,
  useLLM,
  useTextEmbeddings,
} from 'react-native-executorch';
import { getAppSetting, saveAppSetting } from '../data/database';

const modelDownloadedKey = 'offline_ai_model_downloaded';

export function useOfflineStudyHelperStatus() {
  const [isChecking, setIsChecking] = useState(true);
  const [shouldLoad, setShouldLoad] = useState(false);

  const llm = useLLM({
    model: models.llm.qwen2_5_0_5b({ quant: true }),
    preventLoad: !shouldLoad,
  });
  const embeddings = useTextEmbeddings({
    model: MULTI_QA_MINILM_L6_COS_V1,
    preventLoad: !shouldLoad,
  });

  useEffect(() => {
    let isActive = true;

    getAppSetting(modelDownloadedKey)
      .then((value) => {
        if (!isActive) {
          return;
        }

        if (value === 'true') {
          setShouldLoad(true);
        }
      })
      .finally(() => {
        if (isActive) {
          setIsChecking(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!shouldLoad || !llm.isReady || !embeddings.isReady) {
      return;
    }

    saveAppSetting(modelDownloadedKey, 'true');
  }, [embeddings.isReady, llm.isReady, shouldLoad]);

  const progress = Math.round(
    ((llm.downloadProgress + embeddings.downloadProgress) / 2) * 100
  );
  const isReady = llm.isReady && embeddings.isReady;

  return {
    isAvailable,
    isChecking,
    isReady,
    isLoading: shouldLoad && !isReady,
    progress,
    error: llm.error ?? embeddings.error,
    startDownload: () => setShouldLoad(true),
  };
}
