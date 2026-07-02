// ─────────────────────────────────────────────────────────────────────────────
// src/services/tracking.service.js
// Node → Python (SAM 2) integration (S5.3). Calls the tracking sidecar's /track
// endpoint and returns where the per-frame masks were written. Both services
// share the local temp folder, so we pass the frames path by reference.
//
// NOTE: /track is a long request (minutes on a 4 GB GPU). Node's built-in fetch
// (undici) has a ~5-min headers timeout that aborts long requests with
// "fetch failed", so we use the http module here with a generous timeout.
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

    // Socket inactivity timeout — Python is silent while tracking, so keep it large
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`no response after ${Math.round(timeoutMs / 60000)} min`));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Health check (quick — fetch is fine here) ───────────────────────────────

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

// ─── Track an object across a job's frames ───────────────────────────────────

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