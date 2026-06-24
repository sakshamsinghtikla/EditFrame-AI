// Test the video frame pipeline end-to-end — run: node test-video-pipeline.js <path-to-video>
// Verifies: FFmpeg config, metadata (S4.1), extraction (S4.2/S4.3), reassembly (S4.8)
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { isFfmpegReady, getTempDir, cleanTempDir } from './src/config/ffmpeg.js';
import { getVideoMetadata, extractFrames, reassembleVideo, listFrames } from './src/services/video.service.js';

console.log('\n🔍 Testing video frame pipeline…\n');

if (!isFfmpegReady()) {
  console.error('❌ FFmpeg not ready. Run: npm install fluent-ffmpeg ffmpeg-static ffprobe-static\n');
  process.exit(1);
}
console.log('✅ FFmpeg ready (bundled static binaries)');

const videoPath = process.argv[2];
if (!videoPath || !fs.existsSync(videoPath)) {
  console.error('\n❌ Provide a path to a test video:');
  console.error('   node test-video-pipeline.js C:/path/to/video.mp4\n');
  process.exit(1);
}

const jobId = `test_${uuidv4()}`;

try {
  // S4.1 — metadata
  console.log('\n📊 Reading metadata…');
  const meta = await getVideoMetadata(videoPath);
  console.log(`   duration: ${meta.durationSec}s · fps: ${meta.fps} · ${meta.width}×${meta.height} · ${meta.codec} · ~${meta.frameCount} frames`);

  // S4.2/S4.3 — extract frames
  console.log('\n🎞️  Extracting frames…');
  const t0 = Date.now();
  const { jobDir, frameCount, fps } = await extractFrames(videoPath, jobId, {
    onProgress: (pct) => process.stdout.write(`\r   progress: ${pct}%   `),
  });
  console.log(`\n✅ Extracted ${frameCount} frames in ${Date.now()-t0}ms → ${jobDir}`);
  console.log(`   first few: ${listFrames(jobDir).slice(0,3).join(', ')}`);

  // S4.8 — reassemble
  console.log('\n🎬 Reassembling video…');
  const outPath = path.join(getTempDir(), `${jobId}_out.mp4`);
  const t1 = Date.now();
  await reassembleVideo(jobDir, outPath, {
    fps,
    audioFromVideo: videoPath,
    onProgress: (pct) => process.stdout.write(`\r   progress: ${pct}%   `),
  });
  const sizeMb = (fs.statSync(outPath).size/1024/1024).toFixed(2);
  console.log(`\n✅ Reassembled in ${Date.now()-t1}ms → ${outPath} (${sizeMb} MB)`);

  console.log('\n🎉 Video pipeline works! (S4.1, S4.2, S4.3, S4.8 verified)\n');
  console.log(`   Test artifacts left in: ${getTempDir()}`);
  console.log(`   Frames folder: ${jobDir}`);
  console.log('   (Delete them manually, or they will be cleaned by job cleanup.)\n');

  // Comment out the next line if you want to inspect the frames/output:
  cleanTempDir(jobDir);
} catch (err) {
  console.error(`\n❌ Pipeline failed: ${err.message}\n`);
  cleanTempDir(path.join(getTempDir(), jobId));
  process.exit(1);
}