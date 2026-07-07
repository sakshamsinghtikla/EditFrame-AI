// ─────────────────────────────────────────────────────────────────────────────
// src/components/Editor/VideoFrameStudio.jsx
// Sprint 4 — frame extraction + scrubber (S4.6) + navigation (S4.7).
// Sprint 5 — click-to-seed object selection (S5.4) + tracked-mask review
// across frames (S5.5), backed by the local SAM 2 sidecar.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  X, Film, RefreshCw, ChevronLeft, ChevronRight,
  SkipBack, SkipForward, Scissors, Layers, AlertCircle,
  Target, Check, RotateCcw, Eraser,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api.service.js';

const PHASE = { IDLE: 'idle', EXTRACTING: 'extracting', READY: 'ready', ERROR: 'error' };
const FILMSTRIP_COUNT = 28; // sampled thumbnails

// Object-selection sub-flow (S5.4/S5.5), independent of the extraction PHASE above
const TRACK = {
  OFF:        'off',        // no selection in progress
  SELECTING:  'selecting',  // waiting for the user to click an object
  DETECTING:  'detecting',  // segment() in flight — waiting for the single-frame mask
  PREVIEWING: 'previewing', // segment() returned — showing the mask, awaiting confirm
  TRACKING:   'tracking',   // track() running — full propagation (can take minutes)
  TRACKED:    'tracked',    // masks available for every frame
};

function maskFileName(idx) {
  return `mask_${String(idx).padStart(6, '0')}.png`;
}

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

  // ── Object tracking (S5.4/S5.5) state ─────────────────────────────────────
  const [trackMode, setTrackMode]     = useState(TRACK.OFF);
  const [previewMaskUrl, setPreviewMaskUrl] = useState(null); // single-frame preview overlay
  const [mainMaskUrl, setMainMaskUrl] = useState(null);       // tracked overlay for `selected`
  const [trackedInfo, setTrackedInfo] = useState(null);       // { trackedFrames, totalFrames }
  const [trackingMsg, setTrackingMsg] = useState('');
  const [elapsedSec, setElapsedSec]   = useState(0);
  const pendingClick = useRef(null);   // { x, y } in original frame pixels, held during preview
  const requestToken  = useRef(0);     // bumped on cancel so stale responses are ignored

  const urlCache     = useRef(new Map()); // frame name -> object URL
  const maskUrlCache = useRef(new Map()); // frame index -> tracked-mask object URL
  const pollTimer    = useRef(null);
  const elapsedTimer = useRef(null);
  const mainImgRef   = useRef(null);

  // ── Elapsed-time counter shown during DETECTING / TRACKING ────────────────
  useEffect(() => {
    const busy = trackMode === TRACK.DETECTING || trackMode === TRACK.TRACKING;
    if (busy) {
      setElapsedSec(0);
      elapsedTimer.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    } else if (elapsedTimer.current) {
      clearInterval(elapsedTimer.current);
      elapsedTimer.current = null;
    }
    return () => { if (elapsedTimer.current) clearInterval(elapsedTimer.current); };
  }, [trackMode]);

  // ── Fetch a frame as an authenticated object URL (cached) ─────────────────
  const loadFrameUrl = useCallback(async (name) => {
    if (urlCache.current.has(name)) return urlCache.current.get(name);
    const res = await api.get(`/video/extract/${jobId}/frame/${name}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    urlCache.current.set(name, url);
    return url;
  }, [jobId]);

  // ── Fetch a tracked mask as an authenticated object URL (cached) ──────────
  const loadMaskUrl = useCallback(async (idx) => {
    if (maskUrlCache.current.has(idx)) return maskUrlCache.current.get(idx);
    const res = await api.get(`/video/extract/${jobId}/mask/${maskFileName(idx)}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    maskUrlCache.current.set(idx, url);
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
          if (!cancelled) setStrip([...items]);
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

  // ── S5.5: when tracked, load the mask overlay for whichever frame is shown ─
  useEffect(() => {
    if (trackMode !== TRACK.TRACKED) { setMainMaskUrl(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const url = await loadMaskUrl(selected);
        if (!cancelled) setMainMaskUrl(url);
      } catch (_) {
        if (!cancelled) setMainMaskUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selected, trackMode, loadMaskUrl]);

  // ── S5.5: after tracking, preload masks for the sampled filmstrip frames ──
  // so scrubbing to those positions shows the overlay instantly.
  useEffect(() => {
    if (trackMode !== TRACK.TRACKED || strip.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const item of strip) {
        if (cancelled) return;
        try { await loadMaskUrl(item.index); } catch (_) { /* skip */ }
      }
    })();
    return () => { cancelled = true; };
  }, [trackMode, strip, loadMaskUrl]);

  // ── S5.4: click on the main frame → seed a single-frame preview mask ──────
  const handleMainImageClick = useCallback(async (e) => {
    if (trackMode !== TRACK.SELECTING || !mainImgRef.current) return;
    const img  = mainImgRef.current;

    // Guard: if the image hasn't finished loading, naturalWidth/Height are 0,
    // which would make the scale factor Infinity and send garbage coordinates
    // to SAM 2 — a likely cause of a mask covering the whole frame.
    if (!img.naturalWidth || !img.naturalHeight) {
      toast.error('Frame is still loading — wait a moment and click again');
      return;
    }

    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth  / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top)  * scaleY);

    // Sanity-check the computed point actually lands inside the frame
    if (!Number.isFinite(x) || !Number.isFinite(y) ||
        x < 0 || y < 0 || x > img.naturalWidth || y > img.naturalHeight) {
      toast.error('Click position could not be mapped to the frame — try again');
      console.error('[Frame Studio] Bad click coords', { x, y, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, rect });
      return;
    }

    console.log(`[Frame Studio] Click at (${x}, ${y}) of ${img.naturalWidth}×${img.naturalHeight}`);

    pendingClick.current = { x, y };
    const myToken = ++requestToken.current;
    setTrackMode(TRACK.DETECTING);
    setPreviewMaskUrl(null);

    try {
      const res = await api.post(`/video/extract/${jobId}/segment`, {
        sourceFrame: selected,
        points: [[x, y]],
        labels: [1],
      }, { timeout: 320_000 }); // 5+ min — covers cold-start JPEG conversion on a fresh job
      if (myToken !== requestToken.current) return; // cancelled while in flight — ignore
      const fileName = res.data.data.maskUrl.split('/').pop();
      const blob = await api.get(`/video/extract/${jobId}/preview-mask/${fileName}`, { responseType: 'blob' });
      if (myToken !== requestToken.current) return;
      setPreviewMaskUrl(URL.createObjectURL(blob.data));
      setTrackMode(TRACK.PREVIEWING);
    } catch (err) {
      if (myToken !== requestToken.current) return;
      toast.error(err.response?.data?.message || 'Could not detect an object at that point');
      setTrackMode(TRACK.SELECTING);
    }
  }, [trackMode, jobId, selected]);

  // ── S5.2/S5.3: confirm → run full tracking across every frame ─────────────
  const confirmTracking = useCallback(async () => {
    if (!pendingClick.current) return;
    setTrackMode(TRACK.TRACKING);
    setTrackingMsg('Tracking the object across all frames — this can take a few minutes on this GPU…');

    try {
      const res = await api.post(`/video/extract/${jobId}/track`, {
        sourceFrame: selected,
        points: [[pendingClick.current.x, pendingClick.current.y]],
        labels: [1],
      }, { timeout: 35 * 60 * 1000 }); // 35 min — exceeds the backend's 30-min inactivity timeout
      const { trackedFrames, totalFrames } = res.data.data;
      setTrackedInfo({ trackedFrames, totalFrames });
      maskUrlCache.current.clear(); // fresh masks were just written — drop any stale cache
      setTrackMode(TRACK.TRACKED);
      toast.success(`Tracked the object across ${trackedFrames} frames`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Tracking failed');
      setTrackMode(TRACK.PREVIEWING);
    }
  }, [jobId, selected]);

  const retrySelection = useCallback(() => {
    setPreviewMaskUrl(null);
    pendingClick.current = null;
    setTrackMode(TRACK.SELECTING);
  }, []);

  const cancelSelection = useCallback(() => {
    requestToken.current++; // invalidate any in-flight segment/preview request
    setPreviewMaskUrl(null);
    pendingClick.current = null;
    setTrackMode(TRACK.OFF);
  }, []);

  // ── Keyboard navigation (S4.7) ────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (trackMode !== TRACK.OFF) { cancelSelection(); return; }
        onClose();
        return;
      }
      if (phase !== PHASE.READY || trackMode === TRACK.SELECTING) return;
      if (e.key === 'ArrowLeft')  setSelected((i) => Math.max(0, i - 1));
      if (e.key === 'ArrowRight') setSelected((i) => Math.min(frameCount - 1, i + 1));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [phase, frameCount, onClose, trackMode, cancelSelection]);

  // ── Cleanup object URLs + timers on unmount ───────────────────────────────
  useEffect(() => () => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    for (const url of urlCache.current.values()) URL.revokeObjectURL(url);
    for (const url of maskUrlCache.current.values()) URL.revokeObjectURL(url);
    urlCache.current.clear();
    maskUrlCache.current.clear();
  }, []);

  const timeAt = (idx) => {
    const t = idx / (fps || 30);
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1);
    return `${m}:${s.padStart(4, '0')}`;
  };

  const go = (delta) => setSelected((i) => Math.min(frameCount - 1, Math.max(0, i + delta)));

  const overlayStyle = (url) => ({
    position: 'absolute', inset: 0,
    backgroundColor: 'rgba(239,68,68,0.55)',
    WebkitMaskImage: `url(${url})`, maskImage: `url(${url})`,
    WebkitMaskSize: 'contain', maskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center', maskPosition: 'center',
    // Our mask PNGs are opaque grayscale (no alpha channel), so the browser's
    // default alpha-based masking sees "fully visible everywhere" and shows
    // the whole box. Force luminance masking so black/white brightness (not
    // alpha) decides what's clipped — this is the actual object shape.
    WebkitMaskMode: 'luminance', maskMode: 'luminance',
    pointerEvents: 'none', borderRadius: '0.5rem',
  });

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

        {phase === PHASE.READY && trackMode === TRACK.OFF && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTrackMode(TRACK.SELECTING)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/40 text-purple-300 text-sm font-medium transition-all"
            >
              <Target className="w-4 h-4" /> Select Object to Remove
            </button>
            <button
              onClick={() => onPickFrame?.({ jobId, frameName: frames[selected], index: selected, fps, frameCount })}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-400 text-sm font-medium transition-all"
            >
              <Scissors className="w-4 h-4" /> Edit this frame
            </button>
          </div>
        )}

        {trackMode === TRACK.TRACKED && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-medium">
              <Check className="w-3.5 h-3.5" /> Tracked {trackedInfo?.trackedFrames}/{trackedInfo?.totalFrames} frames
            </div>
            <button
              onClick={() => { setTrackMode(TRACK.SELECTING); setTrackedInfo(null); }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/50 hover:text-white text-xs transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Re-select
            </button>
          </div>
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
            {/* Selection status bar */}
            {trackMode !== TRACK.OFF && (
              <div className="flex items-center gap-2.5 px-4 py-2.5 bg-[#0A0F1E] border-b border-white/8 flex-shrink-0">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  trackMode === TRACK.SELECTING  ? 'bg-purple-400 animate-pulse' :
                  trackMode === TRACK.DETECTING  ? 'bg-cyan-400 animate-pulse' :
                  trackMode === TRACK.PREVIEWING ? 'bg-cyan-400' :
                  trackMode === TRACK.TRACKING   ? 'bg-amber-400 animate-pulse' :
                                                    'bg-emerald-400'
                }`} />
                <p className="text-xs text-white/60">
                  {trackMode === TRACK.SELECTING  && 'Click an object in the frame below to select it'}
                  {trackMode === TRACK.DETECTING  && `Detecting object… ${elapsedSec}s (first click on a new job can take ~60s to prepare frames)`}
                  {trackMode === TRACK.PREVIEWING && 'Object detected on this frame — confirm to track it across the whole clip, or try another spot'}
                  {trackMode === TRACK.TRACKING   && `${trackingMsg} (${elapsedSec}s elapsed)`}
                  {trackMode === TRACK.TRACKED    && 'Scrub the timeline to review the tracked object on each frame'}
                </p>
              </div>
            )}

            {/* Main preview */}
            <div className="flex-1 bg-[#060C18] flex items-center justify-center overflow-hidden p-4 relative">
              <div className="relative" style={{ lineHeight: 0 }}>
                {mainUrl
                  ? <img
                      ref={mainImgRef}
                      src={mainUrl}
                      alt={`Frame ${selected}`}
                      onClick={handleMainImageClick}
                      className="max-w-full max-h-full object-contain rounded-lg"
                      style={{
                        cursor: trackMode === TRACK.SELECTING ? 'crosshair' : 'default',
                        maxHeight: '60vh',
                      }}
                    />
                  : <RefreshCw className="w-6 h-6 text-white/30 animate-spin" />}

                {trackMode === TRACK.PREVIEWING && previewMaskUrl && (
                  <div style={overlayStyle(previewMaskUrl)} />
                )}
                {trackMode === TRACK.TRACKED && mainMaskUrl && (
                  <div style={overlayStyle(mainMaskUrl)} />
                )}

                <div className="absolute top-3 left-3 bg-black/60 rounded-lg px-2.5 py-1 text-[11px] font-mono text-white/70">
                  Frame {selected} / {frameCount - 1} · {timeAt(selected)}
                </div>

                {trackMode === TRACK.TRACKING && (
                  <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-3 rounded-lg">
                    <RefreshCw className="w-9 h-9 text-amber-400 animate-spin" />
                    <p className="text-sm text-white font-semibold text-center max-w-xs px-4">{trackingMsg}</p>
                    <p className="text-xs text-white/50">{elapsedSec}s elapsed</p>
                  </div>
                )}

                {trackMode === TRACK.DETECTING && (
                  <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-3 rounded-lg">
                    <RefreshCw className="w-9 h-9 text-cyan-400 animate-spin" />
                    <p className="text-sm text-white font-semibold">Detecting object…</p>
                    <p className="text-xs text-white/50">{elapsedSec}s elapsed — first click on a new job takes longer</p>
                  </div>
                )}
              </div>
            </div>

            {/* Selection action bar (preview confirm / retry / cancel) */}
            {trackMode === TRACK.PREVIEWING && (
              <div className="flex items-center justify-center gap-3 px-4 py-3 bg-[#0D1526] border-t border-white/8 flex-shrink-0">
                <button onClick={cancelSelection}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/50 hover:text-white text-xs transition-colors">
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
                <button onClick={retrySelection} disabled={!previewMaskUrl}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/50 hover:text-white text-xs transition-colors disabled:opacity-40">
                  <RotateCcw className="w-3.5 h-3.5" /> Try another spot
                </button>
                <button onClick={confirmTracking} disabled={!previewMaskUrl}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/40 text-purple-300 text-sm font-semibold transition-all disabled:opacity-40">
                  <Target className="w-4 h-4" /> Track across all frames
                </button>
              </div>
            )}

            {(trackMode === TRACK.SELECTING || trackMode === TRACK.DETECTING) && (
              <div className="flex items-center justify-center gap-3 px-4 py-3 bg-[#0D1526] border-t border-white/8 flex-shrink-0">
                <button onClick={cancelSelection}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/50 hover:text-white text-xs transition-colors">
                  <X className="w-3.5 h-3.5" /> {trackMode === TRACK.DETECTING ? 'Cancel detecting' : 'Cancel selection'}
                </button>
              </div>
            )}

            {trackMode === TRACK.TRACKED && (
              <div className="flex items-center justify-center gap-3 px-4 py-3 bg-[#0D1526] border-t border-white/8 flex-shrink-0">
                <button
                  onClick={() => onPickFrame?.({ jobId, frameName: frames[selected], index: selected, fps, frameCount, tracked: true })}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-400 text-sm font-semibold transition-all"
                >
                  <Eraser className="w-4 h-4" /> Choose frames &amp; remove object
                </button>
              </div>
            )}

            {/* Scrub controls */}
            <div className="bg-[#0D1526] border-t border-white/8 px-4 py-3 flex-shrink-0">
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