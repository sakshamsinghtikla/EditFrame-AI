// src/controllers/tracking.controller.js
import { trackObject, checkTrackingService } from '../services/tracking.service.js';
import { sendSuccess, sendError } from '../utils/response.utils.js';

/**
 * GET /api/video/tracking/health
 * Report whether the SAM 2 sidecar is up and the model is loaded.
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
 * POST /api/video/extract/:jobId/track
 * Body: { sourceFrame, points: [[x,y],...], labels?: [1,0,...], objId? }
 * Runs SAM 2 tracking across the job's frames; returns where masks were written.
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
      jobId:       req.params.jobId,
      sourceFrame: Number(sourceFrame),
      points,
      labels,
      objId,
    });

    return sendSuccess(res, result, `Tracked object across ${result.trackedFrames} frames`);
  } catch (err) {
    return next(err);
  }
}