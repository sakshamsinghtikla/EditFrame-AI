// ─────────────────────────────────────────────────────────────────────────────
// src/components/Editor/VideoFrameStudio.jsx
// Sprint 4 — frame extraction + scrubber (S4.6) + navigation (S4.7).
// Extracts a video into frames, then lets the editor scrub, jump, and step
// frame-by-frame to pick the exact frame to work on (gateway to Sprint 5).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  X, Film, RefreshCw, ChevronLeft, ChevronRight,
  SkipBack, SkipForward, Scissors, Layers, AlertCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api.service.js';

const PHASE = { IDLE: 'idle', EXTRACTING: 'extracting', READY: 'ready', ERROR: 'error' };
const FILMSTRIP_COUNT = 28; // sampled thumbnails

export default function VideoFrameStudio({ asset, onClose, onPickFrame }) {
  const [phase, setPhase]         = useState(PHASE.IDLE);
  const [progress, setProgress]   = useState(0);
  const [stage, setStage]         = useState('');
  const [jobId, setJobId]         = useState(null);
  const [frames, setFrames]       = useState([]);     // all frame filenames
  const [frameCount, setFrameCount] = useState(0);
  const [fps, setFps]             = useState(30);
  const [selected, setSelected]   = useState(0);      // selected frame index
  const [mainUrl, setMainUrl]     = useState(null);   // object URL of selected frame
  const [strip, setStrip]         = useState([]);     // [{ index, name, url }]

  const urlCache = useRef(new Map());                 // name -> object URL
  const pollTimer = useRef(null);

  // ── Fetch a frame as an authenticated object URL (cached) ─────────────────
  const loadFrameUrl = useCallback(async (name) => {
    if (urlCache.current.has(name)) return urlCache.current.get(name);
    const res = await api.get(`/video/extract/${jobId}/frame/${name}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    urlCache.current.set(name, url);
    return url;
  }, [jobId]);

  // ── Start extraction ────────────────────────────────────────────────────────
  const startExtraction = useCallback(async () => {
    setPhase(PHASE.EXTRACTING);
    setProgress(0);
    setStage('starting');
    try {
      const res = await api.post(`/video/${asset.id}/extract`, {});
      const newJobId = res.data.data.jobId;
      setJobId(newJobId);

      // Poll status
      pollTimer.current = setInterval(async () => {
        try {
          const s = await api.get(`/video/extract/${newJobId}/status`);
          const { state, stage: st, progress: pct, result, error } = s.data.data;
          setStage(st);
          setProgress(pct || 0);

          if (state === 'completed') {
            clearInterval(pollTimer.current);
            setFrameCount(result.frameCount);
            setFps(result.fps || 30);
            const list = await api.get(`/video/extract/${newJobId}/frames`);
            setFrames(list.data.data.frames);
            setPhase(PHASE.READY);
          } else if (state === 'failed') {
            clearInterval(pollTimer.current);
            setPhase(PHASE.ERROR);
            toast.error(error || 'Frame extraction failed');
          }
        } catch (err) {
          clearInterval(pollTimer.current);
          setPhase(PHASE.ERROR);
          toast.error('Lost connection to extraction job');
        }
      }, 1500);
    } catch (err) {
      setPhase(PHASE.ERROR);
      toast.error(err.response?.data?.message || 'Could not start extraction');
    }
  }, [asset]);

  // ── Build the filmstrip once frames are ready ─────────────────────────────
  useEffect(() => {
    if (phase !== PHASE.READY || frames.length === 0) return;
    let cancelled = false;

    (async () => {
      const step = Math.max(1, Math.floor(frames.length / FILMSTRIP_COUNT));
      const sampledIdx = [];
      for (let i = 0; i < frames.length; i += step) sampledIdx.push(i);

      const items = [];
      for (const idx of sampledIdx) {
        if (cancelled) return;
        try {
          const url = await loadFrameUrl(frames[idx]);
          items.push({ index: idx, name: frames[idx], url });
          if (!cancelled) setStrip([...items]); // progressive render
        } catch (_) { /* skip a failed thumb */ }
      }
    })();

    return () => { cancelled = true; };
  }, [phase, frames, loadFrameUrl]);

  // ── Load the main preview when the selected frame changes ─────────────────
  useEffect(() => {
    if (phase !== PHASE.READY || frames.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const url = await loadFrameUrl(frames[selected]);
        if (!cancelled) setMainUrl(url);
      } catch (_) { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [selected, phase, frames, loadFrameUrl]);

  // ── Keyboard navigation (S4.7) ────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (phase !== PHASE.READY) return;
      if (e.key === 'ArrowLeft')  setSelected((i) => Math.max(0, i - 1));
      if (e.key === 'ArrowRight') setSelected((i) => Math.min(frameCount - 1, i + 1));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [phase, frameCount, onClose]);

  // ── Cleanup object URLs + timers on unmount ───────────────────────────────
  useEffect(() => () => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    for (const url of urlCache.current.values()) URL.revokeObjectURL(url);
    urlCache.current.clear();
  }, []);

  const timeAt = (idx) => {
    const t = idx / (fps || 30);
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1);
    return `${m}:${s.padStart(4, '0')}`;
  };

  const go = (delta) => setSelected((i) => Math.min(frameCount - 1, Math.max(0, i + delta)));

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-[#060C18] flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-[#0D1526] border-b border-white/10 flex-shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
            <X className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-cyan-500/15 text-cyan-400"><Film className="w-4 h-4" /></div>
            <div>
              <p className="text-sm font-semibold text-white">Frame Studio — {asset.name}</p>
              <p className="text-[11px] text-white/30">
                {phase === PHASE.READY ? `${frameCount} frames · ${fps} fps` : 'Extract frames to begin'}
              </p>
            </div>
          </div>
        </div>
        {phase === PHASE.READY && (
          <button
            onClick={() => onPickFrame?.({ jobId, frameName: frames[selected], index: selected, fps, frameCount })}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-400 text-sm font-medium transition-all"
          >
            <Scissors className="w-4 h-4" /> Edit this frame
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* IDLE — prompt to extract */}
        {phase === PHASE.IDLE && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <div className="p-4 rounded-2xl bg-cyan-500/10 border border-cyan-500/20">
              <Layers className="w-8 h-8 text-cyan-400" />
            </div>
            <div className="text-center">
              <p className="text-white font-medium">Extract frames from this video</p>
              <p className="text-xs text-white/40 mt-1 max-w-sm">
                The video is split into individual frames so you can pick one to edit. This runs locally and may take a little while for long clips.
              </p>
            </div>
            <button onClick={startExtraction}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-400 text-sm font-semibold transition-all">
              <Film className="w-4 h-4" /> Extract Frames
            </button>
          </div>
        )}

        {/* EXTRACTING — progress */}
        {phase === PHASE.EXTRACTING && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <RefreshCw className="w-9 h-9 text-cyan-400 animate-spin" />
            <p className="text-sm text-white font-medium capitalize">{stage || 'working'}…</p>
            <div className="w-64 bg-white/10 rounded-full h-2">
              <div className="bg-cyan-400 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-xs text-white/40">{progress}%</p>
          </div>
        )}

        {/* ERROR */}
        {phase === PHASE.ERROR && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <AlertCircle className="w-8 h-8 text-red-400" />
            <p className="text-sm text-white/70">Frame extraction failed</p>
            <button onClick={startExtraction}
              className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/60 text-xs">
              Try again
            </button>
          </div>
        )}

        {/* READY — scrubber */}
        {phase === PHASE.READY && (
          <>
            {/* Main preview */}
            <div className="flex-1 bg-[#060C18] flex items-center justify-center overflow-hidden p-4 relative">
              {mainUrl
                ? <img src={mainUrl} alt={`Frame ${selected}`} className="max-w-full max-h-full object-contain rounded-lg" />
                : <RefreshCw className="w-6 h-6 text-white/30 animate-spin" />}
              <div className="absolute top-3 left-3 bg-black/60 rounded-lg px-2.5 py-1 text-[11px] font-mono text-white/70">
                Frame {selected} / {frameCount - 1} · {timeAt(selected)}
              </div>
            </div>

            {/* Controls */}
            <div className="bg-[#0D1526] border-t border-white/8 px-4 py-3 flex-shrink-0">
              {/* Nav buttons + slider */}
              <div className="flex items-center gap-3">
                <button onClick={() => setSelected(0)} className="p-1.5 rounded text-white/40 hover:text-white hover:bg-white/10" title="First frame"><SkipBack className="w-4 h-4" /></button>
                <button onClick={() => go(-1)} className="p-1.5 rounded text-white/40 hover:text-white hover:bg-white/10" title="Previous (←)"><ChevronLeft className="w-4 h-4" /></button>

                <input
                  type="range" min={0} max={frameCount - 1} value={selected}
                  onChange={(e) => setSelected(Number(e.target.value))}
                  className="flex-1 accent-cyan-400 cursor-pointer"
                />

                <button onClick={() => go(1)} className="p-1.5 rounded text-white/40 hover:text-white hover:bg-white/10" title="Next (→)"><ChevronRight className="w-4 h-4" /></button>
                <button onClick={() => setSelected(frameCount - 1)} className="p-1.5 rounded text-white/40 hover:text-white hover:bg-white/10" title="Last frame"><SkipForward className="w-4 h-4" /></button>

                {/* Jump-to input */}
                <input
                  type="number" min={0} max={frameCount - 1} value={selected}
                  onChange={(e) => setSelected(Math.min(frameCount - 1, Math.max(0, Number(e.target.value) || 0)))}
                  className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white text-center focus:outline-none focus:border-cyan-500/40"
                />
              </div>

              {/* Filmstrip */}
              <div className="mt-3 flex gap-1 overflow-x-auto scrollbar-hide pb-1">
                {strip.map((f) => (
                  <button
                    key={f.index}
                    onClick={() => setSelected(f.index)}
                    className={`flex-shrink-0 rounded overflow-hidden border-2 transition-all ${
                      selected >= f.index && selected < f.index + Math.max(1, Math.floor(frameCount / FILMSTRIP_COUNT))
                        ? 'border-cyan-400' : 'border-transparent hover:border-white/30'
                    }`}
                    style={{ width: 64, height: 36 }}
                    title={`Frame ${f.index}`}
                  >
                    <img src={f.url} alt={`Frame ${f.index}`} className="w-full h-full object-cover" />
                  </button>
                ))}
                {strip.length === 0 && (
                  <div className="text-[11px] text-white/30 py-2">Loading thumbnails…</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}