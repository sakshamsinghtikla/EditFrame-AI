import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Plus, Download, Trash2, Film, Music, Image,
  Clock, HardDrive, Info, ZoomIn, ZoomOut,
  ChevronLeft, ChevronRight, Pencil, Layers
} from 'lucide-react';
import AssetEditorModal from '../Editor/AssetEditorModal.jsx';
import VideoFrameStudio from '../Editor/VideoFrameStudio.jsx';

function formatDuration(secs) {
  if (!secs) return null;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(mb) {
  if (!mb) return null;
  return mb < 1 ? `${Math.round(mb * 1000)} KB` : `${mb.toFixed(2)} MB`;
}

// ─── Image viewer ─────────────────────────────────────────────────────────────

function ImageViewer({ src, alt }) {
  const [zoom, setZoom]     = useState(1);
  const [pos, setPos]       = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef(null);

  const handleWheel = (e) => {
    e.preventDefault();
    setZoom((z) => Math.min(4, Math.max(0.5, z - e.deltaY * 0.001)));
  };

  const handleMouseDown = (e) => {
    if (zoom <= 1) return;
    setDragging(true);
    dragStart.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  };

  const handleMouseMove = (e) => {
    if (!dragging || !dragStart.current) return;
    setPos({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  };

  const handleMouseUp = () => { setDragging(false); dragStart.current = null; };

  return (
    <div
      className="relative flex-1 overflow-hidden bg-[#060C18] flex items-center justify-center"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}
    >
      <img
        src={src}
        alt={alt}
        className="max-w-full max-h-full object-contain select-none"
        style={{
          transform: `scale(${zoom}) translate(${pos.x / zoom}px, ${pos.y / zoom}px)`,
          transition: dragging ? 'none' : 'transform 0.1s ease',
        }}
        draggable={false}
      />
      <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-black/60 rounded-lg px-2 py-1">
        <button onClick={() => setZoom(z => Math.max(0.5, z - 0.25))} className="p-1 hover:text-cyan-400 text-white/60">
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="text-xs font-mono text-white/60 w-10 text-center">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.min(4, z + 0.25))} className="p-1 hover:text-cyan-400 text-white/60">
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        {zoom !== 1 && (
          <button onClick={() => { setZoom(1); setPos({ x: 0, y: 0 }); }} className="text-[10px] text-cyan-400 ml-1">
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Video viewer ─────────────────────────────────────────────────────────────

function VideoViewer({ src }) {
  return (
    <div className="flex-1 bg-black flex items-center justify-center">
      <video src={src} controls className="max-w-full max-h-full" style={{ maxHeight: '65vh' }} />
    </div>
  );
}

// ─── Audio viewer ─────────────────────────────────────────────────────────────

function AudioViewer({ src, name }) {
  return (
    <div className="flex-1 bg-[#060C18] flex flex-col items-center justify-center gap-6 p-8">
      <div className="w-24 h-24 rounded-full bg-purple-500/20 border border-purple-500/30 flex items-center justify-center">
        <Music className="w-10 h-10 text-purple-400" />
      </div>
      <p className="text-white/60 text-sm text-center max-w-xs truncate">{name}</p>
      <audio src={src} controls className="w-full max-w-md" />
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export default function AssetPreviewModal({
  asset, onClose, onAddToTimeline, onDelete,
  onPrev, onNext, hasPrev, hasNext,
}) {
  const [showInfo, setShowInfo]     = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [showFrames, setShowFrames] = useState(false);
  const [deleting, setDeleting]     = useState(false);

  const isVideo = asset.type === 'VIDEO';

  useEffect(() => {
    const handler = (e) => {
      // Don't let preview-modal shortcuts fire while a child studio/editor is open
      if (showEditor || showFrames) return;
      if (e.key === 'Escape')       onClose();
      if (e.key === 'ArrowLeft'  && hasPrev) onPrev?.();
      if (e.key === 'ArrowRight' && hasNext) onNext?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, hasPrev, hasNext, onPrev, onNext, showEditor, showFrames]);

  const handleDelete = async () => {
    if (!confirm(`Delete "${asset.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    await onDelete?.(asset.id);
    onClose();
  };

  const mediaUrl = asset.cloudinarySecureUrl || asset.cloudinaryUrl;

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex flex-col"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#0D1526] border-b border-white/10 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`p-1.5 rounded-lg flex-shrink-0 ${
              asset.type === 'VIDEO' ? 'bg-cyan-500/15 text-cyan-400' :
              asset.type === 'AUDIO' ? 'bg-purple-500/15 text-purple-400' :
                                       'bg-blue-500/15 text-blue-400'
            }`}>
              {asset.type === 'VIDEO' ? <Film  className="w-4 h-4" /> :
               asset.type === 'AUDIO' ? <Music className="w-4 h-4" /> :
                                        <Image className="w-4 h-4" />}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-white truncate">{asset.name}</p>
              <div className="flex items-center gap-2 text-[11px] text-white/30 mt-0.5">
                {asset.width && asset.height && <span>{asset.width} × {asset.height}px</span>}
                {asset.duration && <span className="flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" />{formatDuration(asset.duration)}</span>}
                {asset.fileSizeMb && <span className="flex items-center gap-0.5"><HardDrive className="w-2.5 h-2.5" />{formatSize(asset.fileSizeMb)}</span>}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={() => setShowInfo(!showInfo)} className={`p-2 rounded-lg transition-colors ${showInfo ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70 hover:bg-white/5'}`} title="File info">
              <Info className="w-4 h-4" />
            </button>

            {/* Frame Studio — video only */}
            {isVideo && (
              <button onClick={() => setShowFrames(true)} className="p-2 rounded-lg text-white/40 hover:text-cyan-400 hover:bg-cyan-500/10 transition-colors" title="Frame Studio">
                <Layers className="w-4 h-4" />
              </button>
            )}

            {/* Edit button — image and video */}
            {asset.type !== 'AUDIO' && (
              <button onClick={() => setShowEditor(true)} className="p-2 rounded-lg text-white/40 hover:text-cyan-400 hover:bg-cyan-500/10 transition-colors" title="Edit">
                <Pencil className="w-4 h-4" />
              </button>
            )}

            <a href={mediaUrl} target="_blank" download={asset.name} className="p-2 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors" title="Download">
              <Download className="w-4 h-4" />
            </a>
            <button onClick={handleDelete} disabled={deleting} className="p-2 rounded-lg text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Delete">
              <Trash2 className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors ml-1">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Main content */}
        <div className="flex flex-1 overflow-hidden">
          <div className="flex flex-1 relative overflow-hidden">
            {asset.type === 'IMAGE' && <ImageViewer src={mediaUrl} alt={asset.name} />}
            {asset.type === 'VIDEO' && <VideoViewer src={mediaUrl} />}
            {asset.type === 'AUDIO' && <AudioViewer src={mediaUrl} name={asset.name} />}

            {hasPrev && (
              <button onClick={onPrev} className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white/60 hover:text-white transition-colors">
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {hasNext && (
              <button onClick={onNext} className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white/60 hover:text-white transition-colors">
                <ChevronRight className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Info panel */}
          <AnimatePresence>
            {showInfo && (
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 240, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex-shrink-0 bg-[#0D1526] border-l border-white/8 overflow-hidden"
              >
                <div className="p-4 space-y-3 w-60">
                  <p className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">File Info</p>
                  {[
                    { label: 'Type',       value: asset.type },
                    { label: 'Name',       value: asset.name },
                    { label: 'Size',       value: formatSize(asset.fileSizeMb) },
                    { label: 'Dimensions', value: asset.width ? `${asset.width}×${asset.height}` : null },
                    { label: 'Duration',   value: formatDuration(asset.duration) },
                    { label: 'FPS',        value: asset.fps ? `${asset.fps} fps` : null },
                    { label: 'Uploaded',   value: asset.createdAt ? new Date(asset.createdAt).toLocaleDateString() : null },
                  ].filter(r => r.value).map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-[10px] text-white/30">{label}</p>
                      <p className="text-xs text-white/70 mt-0.5 truncate">{value}</p>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#0D1526] border-t border-white/10 flex-shrink-0">
          <p className="text-[11px] text-white/30">
            <kbd className="px-1 py-0.5 bg-white/10 rounded text-[10px]">Esc</kbd> close
            {(hasPrev || hasNext) && (
              <> · <kbd className="px-1 py-0.5 bg-white/10 rounded text-[10px]">←</kbd>
              <kbd className="px-1 py-0.5 bg-white/10 rounded text-[10px]">→</kbd> navigate</>
            )}
          </p>
          <button
            onClick={() => { onAddToTimeline?.(asset); onClose(); }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-400 text-sm font-medium transition-all"
          >
            <Plus className="w-4 h-4" /> Add to Timeline
          </button>
        </div>
      </motion.div>

      {/* Image/Video editor modal */}
      <AnimatePresence>
        {showEditor && (
          <AssetEditorModal
            asset={asset}
            onClose={() => setShowEditor(false)}
            onSaved={() => setShowEditor(false)}
          />
        )}
      </AnimatePresence>

      {/* Video Frame Studio — extract & scrub frames (Sprint 4) */}
      <AnimatePresence>
        {showFrames && (
          <VideoFrameStudio
            asset={asset}
            onClose={() => setShowFrames(false)}
            onPickFrame={(info) => {
              // Sprint 5 will use this to run object removal on the chosen frame
              console.log('Picked frame:', info);
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}