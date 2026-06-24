// src/controllers/video.controller.js
import path from 'path';
import prisma from '../config/db.js';
import { getTempDir, cleanTempFile } from '../config/ffmpeg.js';
import {
  getVideoMetadata, downloadToTemp, listFrames, reassembleVideo,
} from '../services/video.service.js';
import { createJob, getJob, runExtractionInline } from '../services/videoJobs.service.js';
import { sendSuccess, sendCreated, sendNotFound, sendError } from '../utils/response.utils.js';

// Optional: broadcast progress over WebSocket if a broadcaster is wired up.
// Soft-fails silently if the WS module isn't available — polling still works.
let wsBroadcast = null;
try {
  const ws = await import('../websocket/ws.server.js');
  wsBroadcast = ws.broadcastToUser || ws.broadcast || null;
} catch (_) { /* WS optional */ }

/**
 * POST /api/video/:id/extract
 * Starts inline frame extraction; returns a jobId immediately.
 * Body: { fps? }
 */
export async function startExtraction(req, res, next) {
  try {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: req.params.id, userId: req.user.id, deletedAt: null },
    });
    if (!asset) return sendNotFound(res, 'Asset');
    if (asset.type !== 'VIDEO') return sendError(res, 'Asset is not a video', 400);

    const jobId = createJob(asset.id);

    // Fire-and-forget — do NOT await, so the request returns immediately
    runExtractionInline(jobId, {
      videoUrl: asset.cloudinarySecureUrl,
      fps:      req.body.fps,
      onProgress: (id, payload) => {
        if (wsBroadcast) {
          try { wsBroadcast(req.user.id, { type: 'frame-extraction', jobId: id, ...payload }); } catch (_) {}
        }
      },
    });

    return sendCreated(res, { jobId }, 'Frame extraction started');
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/video/extract/:jobId/status
 * Poll a job's progress.
 */
export async function getExtractionStatus(req, res, next) {
  try {
    const job = getJob(req.params.jobId);
    if (!job) return sendNotFound(res, 'Job');
    return sendSuccess(res, {
      jobId:    job.id,
      state:    job.state,
      stage:    job.stage,
      progress: job.progress,
      done:     job.done,
      total:    job.total,
      result:   job.result,
      error:    job.error,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/video/extract/:jobId/frames
 * List extracted frame filenames for a completed job.
 */
export async function listJobFrames(req, res, next) {
  try {
    const jobDir = path.join(getTempDir(), req.params.jobId);
    const frames = listFrames(jobDir);
    if (frames.length === 0) {
      return sendError(res, 'No frames found — job may not be complete yet', 404);
    }
    return sendSuccess(res, { jobId: req.params.jobId, frameCount: frames.length, frames });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/video/extract/:jobId/frame/:name
 * Serve a single extracted frame image (for the scrubber UI).
 */
export async function getFrameImage(req, res, next) {
  try {
    const { jobId, name } = req.params;
    // prevent path traversal — only allow our frame filename pattern
    if (!/^frame_\d{6}\.png$/.test(name)) return sendError(res, 'Invalid frame name', 400);
    const filePath = path.join(getTempDir(), jobId, name);
    return res.sendFile(filePath, (err) => { if (err) next(err); });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/video/:id/metadata
 */
export async function getMetadata(req, res, next) {
  try {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: req.params.id, userId: req.user.id, deletedAt: null },
    });
    if (!asset) return sendNotFound(res, 'Asset');
    if (asset.type !== 'VIDEO') return sendError(res, 'Asset is not a video', 400);

    let tmp = null;
    try {
      tmp = await downloadToTemp(asset.cloudinarySecureUrl, '.mp4');
      const meta = await getVideoMetadata(tmp);
      return sendSuccess(res, { metadata: meta });
    } finally {
      cleanTempFile(tmp);
    }
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/video/extract/:jobId/reassemble
 * Body: { fps }
 */
export async function reassemble(req, res, next) {
  try {
    const jobDir = path.join(getTempDir(), req.params.jobId);
    const frames = listFrames(jobDir);
    if (frames.length === 0) return sendError(res, 'No frames to reassemble', 404);

    const fps     = Number(req.body.fps) || 30;
    const outPath = path.join(getTempDir(), `${req.params.jobId}_out.mp4`);
    await reassembleVideo(jobDir, outPath, { fps });

    return sendCreated(res, { outputPath: outPath, frameCount: frames.length }, 'Video reassembled');
  } catch (err) {
    return next(err);
  }
}