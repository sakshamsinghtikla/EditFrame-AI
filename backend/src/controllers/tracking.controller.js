// src/controllers/tracking.controller.js
import path from 'path';
import { trackObject, checkTrackingService, segmentObject } from '../services/tracking.service.js';
import { getTempDir } from '../config/ffmpeg.js';
import { sendSuccess, sendError } from '../utils/response.utils.js';

/**
 * GET /api/video/tracking/health
 */
export async function trackingHealth(req, res, next) {
  try {
    const health = await checkTrackingService();
    return sendSuccess(res, health);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/video/extract/:jobId/segment
 * Body: { sourceFrame, points: [[x,y],...], labels?, objId? }
 * Fast single-frame mask preview (no propagation) — S5.4. Lets the user
 * confirm the click landed on the right object before committing to the
 * full multi-minute tracking run.
 */
export async function segment(req, res, next) {
  try {
    const { sourceFrame, points, labels, objId } = req.body;
    if (sourceFrame === undefined || sourceFrame === null) {
      return sendError(res, 'sourceFrame is required', 400);
    }
    if (!Array.isArray(points) || points.length === 0) {
      return sendError(res, 'points must be a non-empty array of [x, y]', 400);
    }

    const result = await segmentObject({
      jobId: req.params.jobId, sourceFrame: Number(sourceFrame), points, labels, objId,
    });

    const fileName = path.basename(result.maskPath);
    return sendSuccess(res, {
      sourceFrame: result.sourceFrame,
      maskUrl: `/api/video/extract/${req.params.jobId}/preview-mask/${fileName}`,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/video/extract/:jobId/preview-mask/:name
 * Serve a single-frame preview mask (from /segment) — S5.4.
 */
export async function getPreviewMaskImage(req, res, next) {
  try {
    const { jobId, name } = req.params;
    if (!/^preview_\d{6}\.png$/.test(name)) return sendError(res, 'Invalid mask name', 400);
    const filePath = path.join(getTempDir(), jobId, '_preview', name);
    return res.sendFile(filePath, (err) => { if (err) next(err); });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/video/extract/:jobId/mask/:name
 * Serve a tracked mask PNG (mask_000042.png) from a completed /track run — S5.5.
 */
export async function getMaskImage(req, res, next) {
  try {
    const { jobId, name } = req.params;
    if (!/^mask_\d{6}\.png$/.test(name)) return sendError(res, 'Invalid mask name', 400);
    const filePath = path.join(getTempDir(), jobId, 'masks', name);
    return res.sendFile(filePath, (err) => { if (err) next(err); });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/video/extract/:jobId/track
 * Body: { sourceFrame, points: [[x,y],...], labels?, objId? }
 * Full video propagation — S5.2/S5.3.
 */
export async function track(req, res, next) {
  try {
    const { sourceFrame, points, labels, objId } = req.body;
    if (sourceFrame === undefined || sourceFrame === null) {
      return sendError(res, 'sourceFrame is required', 400);
    }
    if (!Array.isArray(points) || points.length === 0) {
      return sendError(res, 'points must be a non-empty array of [x, y]', 400);
    }

    const result = await trackObject({
      jobId: req.params.jobId, sourceFrame: Number(sourceFrame), points, labels, objId,
    });

    return sendSuccess(res, result, `Tracked object across ${result.trackedFrames} frames`);
  } catch (err) {
    return next(err);
  }
}