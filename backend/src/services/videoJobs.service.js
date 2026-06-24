// ─────────────────────────────────────────────────────────────────────────────
// src/services/videoJobs.service.js
// In-memory job tracking for video frame extraction (no Redis required).
// Runs extraction inline in the API process and tracks progress in a Map the
// frontend can poll. For very large workloads you can later switch to the
// BullMQ worker (frameExtraction.queue/worker) instead.
// ─────────────────────────────────────────────────────────────────────────────

import { v4 as uuidv4 } from 'uuid';
import { downloadToTemp, extractFrames } from './video.service.js';
import { cleanTempFile } from '../config/ffmpeg.js';

// jobId -> job record
const jobs = new Map();
const MAX_JOBS = 50; // keep memory bounded

function rememberJob(record) {
  if (jobs.size >= MAX_JOBS) {
    jobs.delete(jobs.keys().next().value); // evict oldest
  }
  jobs.set(record.id, record);
}

export function createJob(assetId) {
  const id = uuidv4();
  rememberJob({
    id, assetId,
    state:    'queued',   // queued | active | completed | failed
    stage:    'queued',   // queued | downloading | extracting | done
    progress: 0,
    done:     0,
    total:    0,
    result:   null,
    error:    null,
    createdAt: Date.now(),
  });
  return id;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

function update(id, patch) {
  const j = jobs.get(id);
  if (j) Object.assign(j, patch);
}

/**
 * Run extraction inline (not awaited by the caller). Updates the job record
 * as it progresses so a status endpoint can report it.
 *
 * @param {string} jobId
 * @param {{ videoUrl:string, fps?:number, onProgress?:Function }} opts
 */
export async function runExtractionInline(jobId, { videoUrl, fps, onProgress }) {
  update(jobId, { state: 'active', stage: 'downloading', progress: 0 });
  let videoPath = null;
  try {
    videoPath = await downloadToTemp(videoUrl, '.mp4');

    update(jobId, { stage: 'extracting' });
    const result = await extractFrames(videoPath, jobId, {
      fps,
      onProgress: (pct, done, total) => {
        update(jobId, { progress: pct, done, total, stage: 'extracting' });
        onProgress?.(jobId, { stage: 'extracting', pct, done, total });
      },
    });

    update(jobId, {
      state: 'completed', stage: 'done', progress: 100,
      result: { jobDir: result.jobDir, frameCount: result.frameCount, fps: result.fps },
    });
    onProgress?.(jobId, { stage: 'done', pct: 100, frameCount: result.frameCount });
  } catch (err) {
    update(jobId, { state: 'failed', error: err.message });
    onProgress?.(jobId, { stage: 'failed', error: err.message });
  } finally {
    cleanTempFile(videoPath); // remove downloaded source; keep extracted frames
  }
}