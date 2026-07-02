// ─────────────────────────────────────────────────────────────────────────────
// src/routes/video.routes.js
// Video frame pipeline routes (Sprint 4).
// Register in server.js:  app.use('/api/video', videoRoutes);
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { param } from 'express-validator';
import { protect } from '../middleware/auth.middleware.js';
import {
  startExtraction, getExtractionStatus, listJobFrames, getMetadata, reassemble, getFrameImage,
} from '../controllers/video.controller.js';
import { track, trackingHealth } from '../controllers/tracking.controller.js';

const router = Router();

// All video routes require auth
router.use(protect);

// SAM 2 tracking service health
router.get('/tracking/health', trackingHealth);

// Metadata for a video asset
router.get('/:id/metadata',
  [param('id').isUUID().withMessage('Invalid asset ID')],
  getMetadata);

// Start extraction (async job)
router.post('/:id/extract',
  [param('id').isUUID().withMessage('Invalid asset ID')],
  startExtraction);

// Poll job status / progress
router.get('/extract/:jobId/status', getExtractionStatus);

// List extracted frames
router.get('/extract/:jobId/frames', listJobFrames);

// Serve a single frame image (for the scrubber)
router.get('/extract/:jobId/frame/:name', getFrameImage);

// Track an object across frames with SAM 2 (S5.3)
router.post('/extract/:jobId/track', track);

// Reassemble frames → video
router.post('/extract/:jobId/reassemble', reassemble);

export default router;