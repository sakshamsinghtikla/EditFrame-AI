// ─────────────────────────────────────────────────────────────────────────────
// src/services/tracking.service.js
// Node → Python (SAM 2) integration.
//   segmentObject() — S5.4: fast single-frame mask preview (confirm the click)
//   trackObject()   — S5.2/S5.3: full video propagation (minutes on 4GB GPU)
//
// NOTE: /track is a long request. Node's built-in fetch (undici) has a ~5-min
// headers timeout that aborts long requests with "fetch failed", so we use the
// http module (postJsonLong) for it. /segment is fast, so plain fetch is fine.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'http';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../config/ffmpeg.js';
import { createAppError } from '../middleware/error.middleware.js';

const SAM2_URL = process.env.SAM2_SERVICE_URL || 'http://127.0.0.1:5001';
const TRACK_TIMEOUT_MS = Number(process.env.SAM2_TIMEOUT_MS || 30 * 60 * 1000); // 30 min inactivity

// ─── Low-level POST that tolerates a long, silent processing period ──────────

function postJsonLong(urlStr, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url  = new URL(urlStr);
    const data = Buffer.from(JSON.stringify(payload));

    const req = http.request(
      {
        hostname: url.hostname,
        port:     url.port,
        path:     url.pathname,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': data.length },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`no response after ${Math.round(timeoutMs / 60000)} min`));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Health check ─────────────────────────────────────────────────────────────

export async function checkTrackingService() {
  try {
    const res = await fetch(`${SAM2_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`health HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw createAppError(
      `SAM 2 tracking service is not reachable at ${SAM2_URL}. Is the Python service running? (${err.message})`,
      503,
      'TRACKING_SERVICE_DOWN'
    );
  }
}

// ─── S5.4: Segment a single frame (fast preview, no propagation) ────────────

/**
 * @returns {Promise<{ maskPath:string, sourceFrame:number }>} absolute path to the mask PNG on disk
 */
export async function segmentObject({ jobId, sourceFrame, points, labels, objId = 1 }) {
  const framesDir = path.join(getTempDir(), jobId);
  if (!fs.existsSync(framesDir)) {
    throw createAppError(`Frames not found for job ${jobId}. Extract frames first.`, 404, 'FRAMES_NOT_FOUND');
  }
  if (!Array.isArray(points) || points.length === 0) {
    throw createAppError('At least one click point is required.', 400, 'NO_POINTS');
  }

  const health = await checkTrackingService();
  if (!health.ready) {
    throw createAppError(`SAM 2 model not ready: ${health.error || 'unknown'}`, 503, 'MODEL_NOT_READY');
  }

  const payload = {
    frames_dir:   framesDir,
    source_frame: sourceFrame,
    points,
    labels:       labels || points.map(() => 1),
    obj_id:       objId,
  };

  let res;
  try {
    res = await fetch(`${SAM2_URL}/segment`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(300_000), // 5 min — comfortably covers cold-start JPEG conversion on a new job
    });
  } catch (err) {
    throw createAppError(`Segmentation request failed: ${err.message}`, 502, 'SEGMENT_REQUEST_FAILED');
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw createAppError(`Segmentation failed: ${detail}`, 502, 'SEGMENT_FAILED');
  }

  const data = await res.json();
  return { maskPath: data.mask_path, sourceFrame: data.source_frame };
}

// ─── S5.2/S5.3: Track an object across all of a job's frames ────────────────

/**
 * @returns {Promise<{ masksDir:string, trackedFrames:number, totalFrames:number, sourceFrame:number }>}
 */
export async function trackObject({ jobId, sourceFrame, points, labels, objId = 1 }) {
  const framesDir = path.join(getTempDir(), jobId);
  if (!fs.existsSync(framesDir)) {
    throw createAppError(`Frames not found for job ${jobId}. Extract frames first.`, 404, 'FRAMES_NOT_FOUND');
  }
  if (!Array.isArray(points) || points.length === 0) {
    throw createAppError('At least one click point is required.', 400, 'NO_POINTS');
  }

  const health = await checkTrackingService();
  if (!health.ready) {
    throw createAppError(`SAM 2 model not ready: ${health.error || 'unknown'}`, 503, 'MODEL_NOT_READY');
  }

  const payload = {
    frames_dir:   framesDir,
    source_frame: sourceFrame,
    points,
    labels:       labels || points.map(() => 1),
    obj_id:       objId,
  };

  let result;
  try {
    result = await postJsonLong(`${SAM2_URL}/track`, payload, TRACK_TIMEOUT_MS);
  } catch (err) {
    throw createAppError(
      `Tracking request failed: ${err.message}. Is the SAM 2 service still running?`,
      502,
      'TRACKING_REQUEST_FAILED'
    );
  }

  if (result.status !== 200) {
    let detail = `HTTP ${result.status}`;
    try { detail = JSON.parse(result.body).detail || detail; } catch (_) {}
    throw createAppError(`Tracking failed: ${detail}`, 502, 'TRACKING_FAILED');
  }

  const data = JSON.parse(result.body);
  return {
    masksDir:      data.masks_dir,
    trackedFrames: data.tracked_frames,
    totalFrames:   data.total_frames,
    sourceFrame:   data.source_frame,
  };
}