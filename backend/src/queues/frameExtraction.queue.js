// ─────────────────────────────────────────────────────────────────────────────
// src/queues/frameExtraction.queue.js
// BullMQ queue for asynchronous video frame extraction (S4.4).
// ─────────────────────────────────────────────────────────────────────────────

import { Queue } from 'bullmq';

export const FRAME_EXTRACTION_QUEUE = 'frame-extraction';

export const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
};

let queue = null;

export function getFrameExtractionQueue() {
  if (!queue) {
    queue = new Queue(FRAME_EXTRACTION_QUEUE, { connection: redisConnection });
  }
  return queue;
}

/**
 * Enqueue a frame-extraction job.
 * @param {{ assetId:string, userId:string, videoUrl:string, fps?:number }} data
 * @returns {Promise<string>} jobId
 */
export async function enqueueFrameExtraction(data) {
  const q = getFrameExtractionQueue();
  const job = await q.add('extract', data, {
    removeOnComplete: 50,
    removeOnFail:     50,
    attempts:         1,
  });
  return job.id;
}