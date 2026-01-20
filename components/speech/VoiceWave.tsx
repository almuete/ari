"use client";

import React, { useCallback, useEffect, useRef } from "react";

type VoiceWaveProps = {
  active: boolean;
  color?: string;       // neon color
  glow?: boolean;
  sensitivity?: number; // 1.0 normal, 1.5 louder
  size?: number;        // px (width/height)
  className?: string;
};

export default function VoiceWave({
  active,
  color = "#22c55e",
  glow = true,
  sensitivity = 1.5,
  size = 160,
  className,
}: VoiceWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const cssSizeRef = useRef(size);
  const colorRef = useRef(color);
  const glowRef = useRef(glow);
  const sensitivityRef = useRef(sensitivity);

  // simple smoothing for "energy" so it feels Jarvis-y
  const energyRef = useRef(0);

  useEffect(() => {
    colorRef.current = color;
    glowRef.current = glow;
    sensitivityRef.current = sensitivity;
  }, [color, glow, sensitivity]);

  const clearCanvas = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
  }, []);

  const stopAll = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    analyserRef.current?.disconnect();
    sourceRef.current?.disconnect();
    analyserRef.current = null;
    sourceRef.current = null;
    dataRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    clearCanvas();
    energyRef.current = 0;
  }, [clearCanvas]);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window === "undefined") return;
    const dpr = window.devicePixelRatio || 1;
    cssSizeRef.current = size;

    canvas.width = Math.floor(size * dpr);
    canvas.height = Math.floor(size * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [size]);

  useEffect(() => {
    resizeCanvas();
  }, [resizeCanvas]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = cssSizeRef.current;
    const h = cssSizeRef.current;
    const cx = w / 2;
    const cy = h / 2;

    // Frequency data for radial bars
    const bufferLength = analyser.frequencyBinCount;
    if (!dataRef.current || dataRef.current.length !== bufferLength) {
      dataRef.current = new Uint8Array(bufferLength) as Uint8Array<ArrayBuffer>;
    }
    const data = dataRef.current;
    analyser.getByteFrequencyData(data);

    // Compute "energy" (volume-ish)
    let sum = 0;
    // focus speech-ish bins (skip very low rumble)
    const startBin = Math.floor(bufferLength * 0.03);
    const endBin = Math.floor(bufferLength * 0.35);
    for (let i = startBin; i < endBin; i++) sum += data[i];
    const avg = sum / Math.max(1, endBin - startBin); // 0..255
    const targetEnergy = Math.min(1, (avg / 255) * sensitivityRef.current);

    // smooth energy for Jarvis feel
    const prev = energyRef.current;
    const next = prev + (targetEnergy - prev) * 0.18;
    energyRef.current = next;

    // background
    ctx.clearRect(0, 0, w, h);

    // glow settings
    const currentColor = colorRef.current;
    if (glowRef.current) {
      ctx.shadowColor = currentColor;
      ctx.shadowBlur = 18;
    } else {
      ctx.shadowBlur = 0;
    }

    // Base ring radius pulses with energy
    const baseRadius = (w * 0.25) + next * (w * 0.03);
    const ringThickness = 3 + next * 2;

    // Outer faint ring
    ctx.beginPath();
    ctx.strokeStyle = currentColor;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 2;
    ctx.arc(cx, cy, baseRadius + 18, 0, Math.PI * 2);
    ctx.stroke();

    // Main ring
    ctx.beginPath();
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = ringThickness;
    ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Inner ring
    ctx.beginPath();
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 2;
    ctx.arc(cx, cy, baseRadius - 12, 0, Math.PI * 2);
    ctx.stroke();

    // Radial bars around ring (Jarvis “equalizer”)
    const bars = 72;
    const step = Math.max(1, Math.floor(bufferLength / bars));
    const barMax = w * 0.12;

    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = 2;

    for (let i = 0; i < bars; i++) {
      const v = data[i * step] / 255; // 0..1
      // make it more speech-reactive + clamp
      const amp = Math.min(1, v * (0.8 + sensitivityRef.current * 0.6));
      const barLen = 6 + amp * barMax;

      const angle = (i / bars) * Math.PI * 2;

      const r1 = baseRadius + 6;
      const r2 = r1 + barLen;

      const x1 = cx + Math.cos(angle) * r1;
      const y1 = cy + Math.sin(angle) * r1;
      const x2 = cx + Math.cos(angle) * r2;
      const y2 = cy + Math.sin(angle) * r2;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // subtle rotating “scanner” arc
    const t = performance.now() * 0.001;
    const scanAngle = t % (Math.PI * 2);
    ctx.beginPath();
    ctx.globalAlpha = 0.55 + next * 0.25;
    ctx.lineWidth = 4;
    ctx.arc(cx, cy, baseRadius + 10, scanAngle, scanAngle + Math.PI * 0.35);
    ctx.stroke();

    // reset alpha for safety
    ctx.globalAlpha = 1;

    rafRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    if (!active) {
      stopAll();
      return;
    }

    // Render stays consistent for SSR hydration; we only feature-detect in effects.
    if (!navigator.mediaDevices?.getUserMedia) {
      stopAll();
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        resizeCanvas();
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;

        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioCtxRef.current = audioCtx;
        if (audioCtx.state === "suspended") {
          // iOS often starts suspended; this is still usually within the user gesture path.
          audioCtx.resume().catch(() => {});
        }

        const source = audioCtx.createMediaStreamSource(stream);
        sourceRef.current = source;

        const analyser = audioCtx.createAnalyser();
        analyserRef.current = analyser;

        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.60;

        source.connect(analyser);

        draw();
      } catch {
        stopAll();
      }
    })();

    return () => {
      cancelled = true;
      stopAll();
    };
  }, [active, draw, resizeCanvas, stopAll]);

  return (
    <div className={className} style={{ width: size, height: size }}>
      <canvas ref={canvasRef} style={{ width: size, height: size, display: "block" }}>
        Your browser does not support the canvas element.
      </canvas>
    </div>
  );
}
