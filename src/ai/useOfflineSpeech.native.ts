import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioStreamBuffer,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
} from 'expo-audio';
import {
  isAvailable,
  models,
  useSpeechToText,
} from 'react-native-executorch';
import type { SpeechToTextType } from 'react-native-executorch';
import { getAppSetting } from '../data/database';

const modelDownloadedKey = 'offline_ai_model_downloaded';
const targetSampleRate = 16000;
const maxRecordingSeconds = 30;
const maxSampleCount = targetSampleRate * maxRecordingSeconds;

type AudioStreamHandle = {
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
};

export function useOfflineSpeech() {
  const [hasCheckedDownload, setHasCheckedDownload] = useState(false);
  const [shouldLoadModel, setShouldLoadModel] = useState(false);
  const [shouldPrepareSpeech, setShouldPrepareSpeech] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const audioBuffersRef = useRef<Float32Array[]>([]);
  const sampleCountRef = useRef(0);
  const isListeningRef = useRef(false);
  const didStartStreamRef = useRef(false);
  const isStoppingStreamRef = useRef(false);

  const handleAudioBuffer = useCallback((buffer: AudioStreamBuffer) => {
    if (!isListeningRef.current || sampleCountRef.current >= maxSampleCount) {
      return;
    }

    const samples = toMonoTargetRate(buffer);
    const remainingSamples = maxSampleCount - sampleCountRef.current;
    const nextSamples = samples.length > remainingSamples
      ? samples.slice(0, remainingSamples)
      : samples;

    if (nextSamples.length === 0) {
      return;
    }

    audioBuffersRef.current.push(nextSamples);
    sampleCountRef.current += nextSamples.length;
  }, []);

  const audioStream = useAudioStream({
    sampleRate: targetSampleRate,
    channels: 1,
    encoding: 'float32',
    onBuffer: handleAudioBuffer,
  });
  const speechToText = useSpeechToText({
    model: models.speech_to_text.whisper_tiny(),
    preventLoad: !isAvailable || !shouldLoadModel || !shouldPrepareSpeech,
  });

  useEffect(() => {
    let isActive = true;

    getAppSetting(modelDownloadedKey)
      .then((value) => {
        if (!isActive) {
          return;
        }

        setShouldLoadModel(value === 'true');
      })
      .finally(() => {
        if (isActive) {
          setHasCheckedDownload(true);
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  const clearBuffers = useCallback(() => {
    audioBuffersRef.current = [];
    sampleCountRef.current = 0;
  }, []);

  const stopStream = useCallback(async () => {
    isListeningRef.current = false;
    setIsListening(false);

    if (didStartStreamRef.current && !isStoppingStreamRef.current) {
      isStoppingStreamRef.current = true;

      try {
        await stopAudioStreamSafely(audioStream.stream);
      } finally {
        didStartStreamRef.current = false;
        isStoppingStreamRef.current = false;
      }
    }

    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      });
    } catch {
      // Restoring audio mode should not block the chat UI.
    }
  }, [audioStream.stream]);

  const requestPermission = useCallback(async () => {
    if (!isAvailable) {
      return false;
    }

    const permission = await requestRecordingPermissionsAsync();
    return permission.granted;
  }, []);

  const prepareVoiceInput = useCallback(() => {
    if (!isAvailable || !hasCheckedDownload || !shouldLoadModel) {
      return false;
    }

    setShouldPrepareSpeech(true);
    return true;
  }, [hasCheckedDownload, shouldLoadModel]);

  const startListening = useCallback(async () => {
    if (
      !isAvailable ||
      !hasCheckedDownload ||
      !shouldLoadModel ||
      !shouldPrepareSpeech ||
      !speechToText.isReady ||
      isListeningRef.current ||
      isTranscribing
    ) {
      return false;
    }

    const stream = audioStream.stream;

    if (!stream) {
      return false;
    }

    const hasPermission = await requestPermission();

    if (!hasPermission) {
      return false;
    }

    clearBuffers();
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
    });

    try {
      await stream.start();
      didStartStreamRef.current = true;
      isListeningRef.current = true;
      setIsListening(true);
      return true;
    } catch {
      didStartStreamRef.current = false;
      isListeningRef.current = false;
      setIsListening(false);

      try {
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
        });
      } catch {
        // Restoring audio mode should not block the chat UI.
      }

      return false;
    }
  }, [
    audioStream.stream,
    clearBuffers,
    hasCheckedDownload,
    isTranscribing,
    requestPermission,
    shouldLoadModel,
    shouldPrepareSpeech,
    speechToText.isReady,
  ]);

  const cancelListening = useCallback(async () => {
    await stopStream();
    clearBuffers();
  }, [clearBuffers, stopStream]);

  const stopAndTranscribe = useCallback(async () => {
    if (!isListeningRef.current) {
      return '';
    }

    await stopStream();
    const waveform = joinBuffers(audioBuffersRef.current, sampleCountRef.current);
    clearBuffers();

    if (waveform.length < targetSampleRate / 3) {
      return '';
    }

    setIsTranscribing(true);

    try {
      return transcribeWithLanguageFallback(speechToText, waveform);
    } finally {
      setIsTranscribing(false);
    }
  }, [clearBuffers, speechToText, stopStream]);

  useEffect(() => {
    const stream = audioStream.stream;

    return () => {
      isListeningRef.current = false;
      didStartStreamRef.current = false;
      clearBuffers();
      void stopAudioStreamSafely(stream);
    };
  }, [audioStream.stream, clearBuffers]);

  return {
    isVoiceAvailable: isAvailable,
    isListening,
    isTranscribing,
    isReady: speechToText.isReady,
    hasCheckedDownload,
    shouldLoadModel,
    shouldPrepareSpeech,
    downloadProgress: speechToText.downloadProgress,
    error: speechToText.error,
    prepareVoiceInput,
    requestPermission,
    startListening,
    stopAndTranscribe,
    cancelListening,
  };
}

async function transcribeWithLanguageFallback(
  speechToText: SpeechToTextType,
  waveform: Float32Array
) {
  const tagalogResult = await speechToText.transcribe(waveform, {
    language: 'tl',
  });
  const tagalogText = tagalogResult.text.trim();

  if (isUsableTranscript(tagalogText)) {
    return tagalogText;
  }

  try {
    const englishResult = await speechToText.transcribe(waveform, {
      language: 'en',
    });
    const englishText = englishResult.text.trim();

    return isUsableTranscript(englishText) ? englishText : tagalogText;
  } catch {
    return tagalogText;
  }
}

function isUsableTranscript(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();

  return (
    normalized.length >= 3 &&
    !/^\W+$/.test(normalized) &&
    !/^(you|uh|um|hmm)$/i.test(normalized)
  );
}

async function stopAudioStreamSafely(stream?: AudioStreamHandle | null) {
  if (!stream) {
    return;
  }

  try {
    await stream.stop();
  } catch {
    // Expo can release AudioStream during remount cleanup before stop resolves.
  }
}

function toMonoTargetRate(buffer: AudioStreamBuffer) {
  const frames = new Float32Array(buffer.data);
  const mono = buffer.channels > 1
    ? averageInterleavedChannels(frames, buffer.channels)
    : frames;

  if (buffer.sampleRate === targetSampleRate) {
    return new Float32Array(mono);
  }

  return resampleLinear(mono, buffer.sampleRate, targetSampleRate);
}

function averageInterleavedChannels(frames: Float32Array, channelCount: number) {
  const monoLength = Math.floor(frames.length / channelCount);
  const mono = new Float32Array(monoLength);

  for (let frameIndex = 0; frameIndex < monoLength; frameIndex += 1) {
    let total = 0;

    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      total += frames[(frameIndex * channelCount) + channelIndex] ?? 0;
    }

    mono[frameIndex] = total / channelCount;
  }

  return mono;
}

function resampleLinear(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
) {
  if (input.length === 0 || inputSampleRate <= 0) {
    return new Float32Array();
  }

  const outputLength = Math.max(
    1,
    Math.round((input.length * outputSampleRate) / inputSampleRate)
  );
  const output = new Float32Array(outputLength);
  const ratio = input.length / outputLength;

  for (let index = 0; index < outputLength; index += 1) {
    const inputIndex = index * ratio;
    const lowerIndex = Math.floor(inputIndex);
    const upperIndex = Math.min(lowerIndex + 1, input.length - 1);
    const weight = inputIndex - lowerIndex;

    output[index] =
      ((input[lowerIndex] ?? 0) * (1 - weight)) +
      ((input[upperIndex] ?? 0) * weight);
  }

  return output;
}

function joinBuffers(buffers: Float32Array[], sampleCount: number) {
  const waveform = new Float32Array(sampleCount);
  let offset = 0;

  for (const buffer of buffers) {
    waveform.set(buffer, offset);
    offset += buffer.length;
  }

  return waveform;
}
