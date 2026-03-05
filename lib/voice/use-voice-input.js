'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Audio processor worklet source — registered inline via Blob URL
 * to avoid needing a separate static file.
 */
const WORKLET_SRC = /* js */ `
class PcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) this.port.postMessage(input);
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
`;

/**
 * Reusable voice input hook using AssemblyAI real-time transcription.
 *
 * @param {Object} options
 * @param {() => Promise<{token?: string, error?: string}>} options.getToken - Async function returning a temporary token
 * @param {(text: string) => void} options.onTranscript - Called with finalized transcript text
 * @param {(error: string) => void} [options.onError] - Called on errors
 * @param {(rms: number) => void} [options.onVolumeChange] - Called with RMS volume level on each audio frame
 * @returns {{ isConnecting: boolean, isRecording: boolean, startRecording: () => void, stopRecording: () => void }}
 */
export function useVoiceInput({ getToken, onTranscript, onError, onVolumeChange }) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const workletRef = useRef(null);
  const sourceRef = useRef(null);
  const cleaningUpRef = useRef(false);
  const connectingRef = useRef(false);

  const cleanup = useCallback(() => {
    if (cleaningUpRef.current) return;
    cleaningUpRef.current = true;

    if (workletRef.current) {
      workletRef.current.disconnect();
      workletRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'Terminate' }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }

    connectingRef.current = false;
    setIsConnecting(false);
    setIsRecording(false);
    cleaningUpRef.current = false;
  }, []);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  const startRecording = useCallback(async () => {
    // Guard against double-clicks during async setup
    if (connectingRef.current || cleaningUpRef.current) return;
    connectingRef.current = true;
    setIsConnecting(true);

    try {
      const result = await getToken();
      if (result.error) {
        onError?.(result.error);
        cleanup();
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      // Register AudioWorklet from inline source (replaces deprecated ScriptProcessorNode)
      const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const ws = new WebSocket(
        `wss://streaming.assemblyai.com/v3/ws?token=${result.token}&sample_rate=16000&encoding=pcm_s16le`
      );
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        const source = audioCtx.createMediaStreamSource(stream);
        sourceRef.current = source;

        const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
        workletRef.current = workletNode;

        workletNode.port.onmessage = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const float32 = e.data;
          const int16 = new Int16Array(float32.length);
          let sum = 0;
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            sum += s * s;
          }
          ws.send(int16.buffer);
          if (onVolumeChange) onVolumeChange(Math.sqrt(sum / float32.length));
        };

        source.connect(workletNode);
        workletNode.connect(audioCtx.destination);
        setIsConnecting(false);
        setIsRecording(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'Turn') {
            const text = data.transcript?.trim();
            if (text) onTranscript(text);
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        onError?.('Voice connection error');
        cleanup();
      };

      ws.onclose = () => {
        cleanup();
      };
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        onError?.('Microphone permission denied');
      } else {
        onError?.('Failed to start voice input');
      }
      cleanup();
    }
  }, [getToken, onTranscript, onError, onVolumeChange, cleanup]);

  const stopRecording = useCallback(() => {
    cleanup();
  }, [cleanup]);

  return { isConnecting, isRecording, startRecording, stopRecording };
}
