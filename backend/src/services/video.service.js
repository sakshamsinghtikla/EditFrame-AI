// ─────────────────────────────────────────────────────────────────────────────
// src/services/video.service.js
// Core video pipeline: metadata (S4.1), frame extraction (S4.2),
// frame naming/indexing (S4.3), and reassembly (S4.8).
// Frames are stored on local temp disk in a per-job folder.
// ─────────────────────────────────────────────────────────────────────────────

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getFfmpeg, getJobDir, getTempDir, cleanTempFile } from '../config/ffmpeg.js';

// ─── S4.3: Frame naming / indexing contract ──────────────────────────────────
// Zero-padded so lexical sort === temporal order. Extraction and reassembly
// MUST share this exact pattern.
const FRAME_PREFIX  = 'frame_';
const FRAME_DIGITS  = 6;                 // supports up to 999,999 frames
const FRAME_EXT     = 'png';
const FRAME_GLOB    = `${FRAME_PREFIX}%0${FRAME_DIGITS}d.${FRAME_EXT}`; // frame_%06d.png

export function frameFileName(index) {
  return `${FRAME_PREFIX}${String(index).padStart(FRAME_DIGITS, '0')}.${FRAME_EXT}`;
}

function frameIndexFromName(name) {
  const m = name.match(new RegExp(`${FRAME_PREFIX}(\\d+)\\.${FRAME_EXT}`));
  return m ? parseInt(m[1], 10) : -1;
}

// ─── Download a remote video to temp (FFmpeg reads local files reliably) ─────

export function downloadToTemp(url, ext = '.mp4') {
  return new Promise((resolve, reject) => {
    const dest     = path.join(getTempDir(), `src_${uuidv4()}${ext}`);
    const file     = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); cleanTempFile(dest);
        return downloadToTemp(res.headers.location, ext).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); cleanTempFile(dest);
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', (err) => { cleanTempFile(dest); reject(err); });
    }).on('error', reject);
  });
}

// ─── S4.1: Read video metadata ────────────────────────────────────────────────

/**
 * @param {string} filePath - local path to a video
 * @returns {Promise<{durationSec:number, fps:number, width:number, height:number, codec:string, frameCount:number}>}
 */
export function getVideoMetadata(filePath) {
  const ffmpeg = getFfmpeg();
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));

      const stream = (data.streams || []).find((s) => s.codec_type === 'video');
      if (!stream) return reject(new Error('No video stream found'));

      // fps may be "30000/1001" etc.
      let fps = 30;
      if (stream.r_frame_rate && stream.r_frame_rate.includes('/')) {
        const [a, b] = stream.r_frame_rate.split('/').map(Number);
        if (b > 0) fps = a / b;
      } else if (stream.avg_frame_rate) {
        const [a, b] = stream.avg_frame_rate.split('/').map(Number);
        if (b > 0) fps = a / b;
      }

      const durationSec = parseFloat(data.format?.duration || stream.duration || 0);
      const frameCount  = stream.nb_frames
        ? parseInt(stream.nb_frames, 10)
        : Math.round(durationSec * fps);

      resolve({
        durationSec,
        fps:       Math.round(fps * 1000) / 1000,
        width:     stream.width,
        height:    stream.height,
        codec:     stream.codec_name,
        frameCount,
      });
    });
  });
}

// ─── S4.2 + S4.3: Extract frames to a per-job folder ─────────────────────────

/**
 * Extract frames from a video into a job folder using the shared naming scheme.
 *
 * @param {string} videoPath  - local video file
 * @param {string} jobId      - unique id; frames go to <temp>/<jobId>/
 * @param {object} [opts]
 * @param {number} [opts.fps]  - frames per second to extract (default: source fps)
 * @param {(pct:number, done:number, total:number)=>void} [opts.onProgress]
 * @returns {Promise<{ jobDir:string, frameCount:number, fps:number, frames:string[] }>}
 */
export async function extractFrames(videoPath, jobId, opts = {}) {
  const ffmpeg = getFfmpeg();
  const meta   = await getVideoMetadata(videoPath);
  const fps    = opts.fps || meta.fps;
  const jobDir = getJobDir(jobId);
  const outPattern = path.join(jobDir, FRAME_GLOB);
  const estimatedTotal = Math.max(1, Math.round(meta.durationSec * fps));

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg(videoPath)
      .outputOptions([`-vf fps=${fps}`, '-start_number 0'])
      .output(outPattern);

    if (opts.onProgress) {
      cmd.on('progress', (p) => {
        // p.frames is the count emitted so far
        const done = p.frames || 0;
        const pct  = Math.min(99, Math.round((done / estimatedTotal) * 100));
        opts.onProgress(pct, done, estimatedTotal);
      });
    }

    cmd.on('end', resolve)
       .on('error', (err) => reject(new Error(`Frame extraction failed: ${err.message}`)))
       .run();
  });

  const frames = listFrames(jobDir);
  if (opts.onProgress) opts.onProgress(100, frames.length, frames.length);

  return { jobDir, frameCount: frames.length, fps, frames };
}

// ─── List frames in a job folder, in temporal order ──────────────────────────

export function listFrames(jobDir) {
  if (!fs.existsSync(jobDir)) return [];
  return fs.readdirSync(jobDir)
    .filter((f) => f.startsWith(FRAME_PREFIX) && f.endsWith(`.${FRAME_EXT}`))
    .sort((a, b) => frameIndexFromName(a) - frameIndexFromName(b));
}

// ─── S4.8: Reassemble frames back into a video ───────────────────────────────

/**
 * Stitch frames in a job folder back into a video at the given fps.
 * Optionally muxes an audio track from the original video.
 *
 * @param {string} jobDir    - folder containing frame_######.png
 * @param {string} outPath   - output video path
 * @param {object} opts
 * @param {number} opts.fps
 * @param {string} [opts.audioFromVideo] - local video path to copy audio from
 * @param {(pct:number)=>void} [opts.onProgress]
 * @returns {Promise<string>} outPath
 */
export async function reassembleVideo(jobDir, outPath, opts = {}) {
  const ffmpeg = getFfmpeg();
  const fps    = opts.fps || 30;
  const inputPattern = path.join(jobDir, FRAME_GLOB);

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(inputPattern)
      .inputOptions([`-framerate ${fps}`, '-start_number 0']);

    if (opts.audioFromVideo && fs.existsSync(opts.audioFromVideo)) {
      cmd.input(opts.audioFromVideo);
    }

    cmd.outputOptions([
      '-c:v libx264',
      '-pix_fmt yuv420p',     // broad player compatibility
      '-r ' + fps,
    ]);

    if (opts.audioFromVideo) {
      cmd.outputOptions(['-c:a aac', '-map 0:v:0', '-map 1:a:0?', '-shortest']);
    }

    if (opts.onProgress) {
      cmd.on('progress', (p) => opts.onProgress(Math.min(99, Math.round(p.percent || 0))));
    }

    cmd.output(outPath)
       .on('end', () => { if (opts.onProgress) opts.onProgress(100); resolve(); })
       .on('error', (err) => reject(new Error(`Reassembly failed: ${err.message}`)))
       .run();
  });

  return outPath;
}