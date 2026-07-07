// ─────────────────────────────────────────────────────────────────────────────
// src/workers/frameExtraction.worker.js
// Processes frame-extraction jobs (S4.4). Run as a separate process:
//   node src/workers/frameExtraction.worker.js
// Emits progress to BullMQ (job.updateProgress) which the API relays over WS.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { Worker } from 'bullmq';
import { FRAME_EXTRACTION_QUEUE, redisConnection } from '../queues/frameExtraction.queue.js';
import { downloadToTemp, extractFrames } from '../services/video.service.js';
import { cleanTempFile } from '../config/ffmpeg.js';

console.log('[frame-extraction worker] starting…');

const worker = new Worker(
  FRAME_EXTRACTION_QUEUE,
  async (job) => {
    const { assetId, videoUrl, fps } = job.data;
    console.log(`[frame-extraction] job ${job.id} for asset ${assetId}`);

    let videoPath = null;
    try {
      // 1. Download the source video to temp
      await job.updateProgress({ stage: 'downloading', pct: 0 });
      videoPath = await downloadToTemp(videoUrl, '.mp4');

      // 2. Extract frames (job folder is keyed by the job id)
      const result = await extractFrames(videoPath, String(job.id), {
        fps,
        onProgress: async (pct, done, total) => {
          await job.updateProgress({ stage: 'extracting', pct, done, total });
        },
      });

      return {
        jobId:      String(job.id),
        assetId,
        jobDir:     result.jobDir,
        frameCount: result.frameCount,
        fps:        result.fps,
      };
    } finally {
      cleanTempFile(videoPath); // remove the downloaded source; keep the frames
    }
  },
  { connection: redisConnection, concurrency: 1 }
);

worker.on('completed', (job, result) => {
  console.log(`[frame-extraction] job ${job.id} done — ${result.frameCount} frames`);
});
worker.on('failed', (job, err) => {
  console.error(`[frame-extraction] job ${job?.id} failed: ${err.message}`);
});

process.on('SIGINT', async () => { await worker.close(); process.exit(0); });