// ─────────────────────────────────────────────────────────────────────────────
// src/config/ffmpeg.js
// FFmpeg configuration using bundled static binaries (no system install needed).
// Also provides temp-directory helpers used across the app.
// Soft-fails: if packages/binaries are missing, it warns instead of crashing.
// ─────────────────────────────────────────────────────────────────────────────

import os from 'os';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

let ffmpeg = null;
let ffmpegReady = false;

// ─── Wire up fluent-ffmpeg with static binaries ──────────────────────────────

try {
  const mod          = await import('fluent-ffmpeg');
  ffmpeg             = mod.default;
  const ffmpegStatic = (await import('ffmpeg-static')).default;
  const ffprobeStatic = (await import('ffprobe-static')).default;

  if (ffmpegStatic)  ffmpeg.setFfmpegPath(ffmpegStatic);
  if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

  ffmpegReady = true;
  console.log('[FFmpeg] Ready (using bundled static binaries)');
} catch (err) {
  console.warn('[FFmpeg] Not configured — run: npm install fluent-ffmpeg ffmpeg-static ffprobe-static');
  console.warn(`[FFmpeg] (${err.message})`);
}

// ─── Temp directory helpers (used by image + video services) ─────────────────

/**
 * Returns a writable temp directory, creating it if needed.
 * Prefers FFMPEG_TEMP_DIR from .env, falls back to the OS temp dir.
 */
export function getTempDir() {
  const preferred = process.env.FFMPEG_TEMP_DIR;
  const dir = preferred || path.join(os.tmpdir(), 'editframe-temp');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    // Fall back to OS temp if the preferred dir can't be created (e.g. Windows EPERM)
    const fallback = path.join(os.tmpdir(), 'editframe-temp');
    try { if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true }); } catch (_) {}
    return fallback;
  }
}

/**
 * Creates (and returns) a unique sub-directory inside the temp dir,
 * useful for per-job frame folders.
 */
export function getJobDir(jobId) {
  const dir = path.join(getTempDir(), jobId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Best-effort delete of a single temp file. */
export function cleanTempFile(filePath) {
  if (!filePath) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}

/**
 * Build a unique temp file path with a given extension and optional prefix.
 * (Does not create the file — just returns a path inside the temp dir.)
 * @param {string} [ext='.tmp']
 * @param {string} [prefix='tmp_']
 * @returns {string}
 */
export function tempFilePath(ext = '.tmp', prefix = 'tmp_') {
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
  return path.join(getTempDir(), `${prefix}${uuidv4()}${safeExt}`);
}

/**
 * Probe a media file/URL with ffprobe and return the raw metadata object.
 * @param {string} input - local path or URL
 * @returns {Promise<object>} raw ffprobe data
 */
export function probeMedia(input) {
  const ff = getFfmpeg();
  return new Promise((resolve, reject) => {
    ff.ffprobe(input, (err, data) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
      resolve(data);
    });
  });
}

/**
 * Normalize raw ffprobe metadata into the fields EditFrame stores.
 * @param {object} metadata - raw ffprobe output (from probeMedia)
 * @returns {{ durationSec:number, fps:number, width:number, height:number, codec:string, frameCount:number, hasAudio:boolean }}
 */
export function extractMediaInfo(metadata) {
  const streams = metadata?.streams || [];
  const video   = streams.find((s) => s.codec_type === 'video');
  const audio   = streams.find((s) => s.codec_type === 'audio');

  let fps = 0;
  if (video?.r_frame_rate && video.r_frame_rate.includes('/')) {
    const [a, b] = video.r_frame_rate.split('/').map(Number);
    if (b > 0) fps = a / b;
  } else if (video?.avg_frame_rate && video.avg_frame_rate.includes('/')) {
    const [a, b] = video.avg_frame_rate.split('/').map(Number);
    if (b > 0) fps = a / b;
  }

  const durationSec = parseFloat(metadata?.format?.duration || video?.duration || 0);
  const frameCount  = video?.nb_frames
    ? parseInt(video.nb_frames, 10)
    : (fps ? Math.round(durationSec * fps) : 0);

  return {
    durationSec,
    fps:        fps ? Math.round(fps * 1000) / 1000 : 0,
    width:      video?.width  || null,
    height:     video?.height || null,
    codec:      video?.codec_name || null,
    frameCount,
    hasAudio:   !!audio,
  };
}

/** Best-effort recursive delete of a temp directory (e.g. a job's frames). */
export function cleanTempDir(dirPath) {
  if (!dirPath) return;
  try { if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true }); } catch (_) {}
}

/** Whether FFmpeg is available. */
export function isFfmpegReady() {
  return ffmpegReady;
}

/** The configured fluent-ffmpeg instance (or null if unavailable). */
export function getFfmpeg() {
  if (!ffmpegReady || !ffmpeg) {
    throw new Error('FFmpeg is not available. Run: npm install fluent-ffmpeg ffmpeg-static ffprobe-static');
  }
  return ffmpeg;
}

/**
 * Called by server.js at startup. Configuration already happens at import time
 * (above), so this just reports status and ensures the temp dir exists.
 * Kept for backward compatibility with the original API.
 * @returns {boolean} whether FFmpeg is ready
 */
export function configureFfmpeg() {
  try { getTempDir(); } catch (_) {}
  if (ffmpegReady) {
    console.log('[FFmpeg] configureFfmpeg(): ready');
  } else {
    console.warn('[FFmpeg] configureFfmpeg(): not available — video features disabled until installed');
  }
  return ffmpegReady;
}

export default ffmpeg;