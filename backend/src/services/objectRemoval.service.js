// ─────────────────────────────────────────────────────────────────────────────
// src/services/objectRemoval.service.js
// LOCAL object removal using the LaMa ONNX model via onnxruntime-node.
// No external API — runs entirely on your machine, offline and free.
//
// Pipeline: paint mask → resize to 512×512 → ONNX inference → resize back
//           → composite (only masked region replaced) → upload to Cloudinary.
// ─────────────────────────────────────────────────────────────────────────────

import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/db.js';
import { getFolder } from '../config/cloudinary.js';
import { getTempDir, cleanTempFile } from '../config/ffmpeg.js';
import { createAppError } from '../middleware/error.middleware.js';
import { incrementStorageUsage } from '../utils/quota.utils.js';
import { bytesToMb } from '../utils/cloudinary.utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── File logger (terminal reloads on --watch, so log to a file too) ─────────
const LOG_FILE = path.resolve(__dirname, '../../lama-debug.log');
function logToFile(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  console.log(msg);
}

// Model lives at backend/models/lama_fp32.onnx
const MODEL_PATH = path.resolve(__dirname, '../../models/lama_fp32.onnx');
const MODEL_SIZE = 512; // LaMa ONNX fixed input size

// ─── Lazy-load onnxruntime + session (cached across requests) ────────────────

let ortModule = null;
let sessionPromise = null;

async function getSession() {
  if (!fs.existsSync(MODEL_PATH)) {
    throw createAppError(
      'LaMa model not found. Download lama_fp32.onnx into backend/models/ (see setup instructions).',
      500,
      'MODEL_NOT_FOUND'
    );
  }

  if (!ortModule) {
    try {
      ortModule = await import('onnxruntime-node');
    } catch (err) {
      throw createAppError(
        'onnxruntime-node is not installed. Run: npm install onnxruntime-node',
        500,
        'ONNX_NOT_INSTALLED'
      );
    }
  }

  if (!sessionPromise) {
    console.log('[LaMa] Loading ONNX model (first run only)…');
    sessionPromise = ortModule.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    }).then((s) => {
      console.log('[LaMa] Model loaded. Inputs:', s.inputNames, 'Outputs:', s.outputNames);
      return s;
    });
  }

  return sessionPromise;
}

// ─── Buffer helpers ───────────────────────────────────────────────────────────

function dataUrlToBuffer(dataUrl) {
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64, 'base64');
}

async function fetchImageBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── Core: run LaMa inpainting locally ────────────────────────────────────────

/**
 * Run local LaMa inpainting on a single image+mask pair.
 * Exported so it can be reused for batch video-frame removal (S5.7).
 * @param {Buffer} imageBuffer  - original image
 * @param {Buffer} maskBuffer   - mask PNG (white = remove)
 * @returns {Promise<Buffer>}   - inpainted PNG at original resolution
 */
export async function runLaMa(imageBuffer, maskBuffer) {
  const session = await getSession();  // loads ortModule if not already loaded
  const ort     = ortModule;           // now safe to read

  try {
    console.log('[LaMa] Step 1: reading image metadata');
    const meta = await sharp(imageBuffer).metadata();
    const W = meta.width;
    const H = meta.height;
    console.log(`[LaMa] Image is ${W}×${H}`);

  // 1. Resize image → 512×512 raw RGB
  const { data: imgData } = await sharp(imageBuffer)
    .resize(MODEL_SIZE, MODEL_SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 2. Resize mask → 512×512 grayscale raw
  const { data: maskData } = await sharp(maskBuffer)
    .resize(MODEL_SIZE, MODEL_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Diagnostic: how many pixels are "white" (to be removed)?
  let whiteCount = 0;
  for (let i = 0; i < maskData.length; i++) if (maskData[i] > 127) whiteCount++;
  logToFile(`[LaMa] Mask white pixels: ${whiteCount} / ${maskData.length} (${(whiteCount/maskData.length*100).toFixed(1)}%)`);
  if (whiteCount === 0) {
    logToFile('[LaMa] WARNING: mask is empty — nothing will be removed. The painted mask did not reach the backend.');
  }

  // 3. Build tensors — image CHW [0,1], mask [1,1,H,W] {0,1}
  const px        = MODEL_SIZE * MODEL_SIZE;
  const imgFloat  = new Float32Array(3 * px);
  const maskFloat = new Float32Array(px);

  for (let i = 0; i < px; i++) {
    imgFloat[i]          = imgData[i * 3]     / 255; // R
    imgFloat[px + i]     = imgData[i * 3 + 1] / 255; // G
    imgFloat[2 * px + i] = imgData[i * 3 + 2] / 255; // B
    maskFloat[i]         = maskData[i] > 127 ? 1 : 0;
  }

  const imageTensor = new ort.Tensor('float32', imgFloat,  [1, 3, MODEL_SIZE, MODEL_SIZE]);
  const maskTensor  = new ort.Tensor('float32', maskFloat, [1, 1, MODEL_SIZE, MODEL_SIZE]);

  // 4. Run inference (use the model's actual input names)
  const feeds = {};
  feeds[session.inputNames[0]] = imageTensor;
  feeds[session.inputNames[1]] = maskTensor;

  console.log('[LaMa] Running inference…');
  const t0 = Date.now();
  const results = await session.run(feeds);
  console.log(`[LaMa] Inference done in ${Date.now() - t0}ms`);

  const output = results[session.outputNames[0]];
  const out    = output.data; // Float32Array, [1,3,512,512]

  // Diagnostic: output value range
  let oMin = Infinity, oMax = -Infinity;
  for (let i = 0; i < out.length; i += 311) { oMin = Math.min(oMin, out[i]); oMax = Math.max(oMax, out[i]); }
  logToFile(`[LaMa] Output range: min=${oMin.toFixed(3)} max=${oMax.toFixed(3)}`);

  // Detect output range (some exports give [0,1], others [0,255])
  let maxVal = 0;
  for (let i = 0; i < out.length; i += 997) maxVal = Math.max(maxVal, out[i]);
  const scale = maxVal <= 1.5 ? 255 : 1;

  // 5. CHW → HWC raw RGB buffer
  const lamaRaw = Buffer.alloc(px * 3);
  for (let i = 0; i < px; i++) {
    lamaRaw[i * 3]     = Math.min(255, Math.max(0, Math.round(out[i]          * scale)));
    lamaRaw[i * 3 + 1] = Math.min(255, Math.max(0, Math.round(out[px + i]     * scale)));
    lamaRaw[i * 3 + 2] = Math.min(255, Math.max(0, Math.round(out[2 * px + i] * scale)));
  }

  // 6. Resize LaMa output back to original size
  const lamaFull = await sharp(lamaRaw, { raw: { width: MODEL_SIZE, height: MODEL_SIZE, channels: 3 } })
    .resize(W, H, { fit: 'fill' })
    .raw()
    .toBuffer();

  // 7. Composite — only replace masked pixels, keep original elsewhere (sharp edges, full quality)
  const origFull = await sharp(imageBuffer).removeAlpha().raw().toBuffer();
  const maskFull = await sharp(maskBuffer)
    .resize(W, H, { fit: 'fill' })
    .grayscale()
    .blur(2)               // soft edge for seamless blend
    .raw()
    .toBuffer();

  const finalRaw = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const a = maskFull[i] / 255; // blend factor
    finalRaw[i * 3]     = Math.round(origFull[i * 3]     * (1 - a) + lamaFull[i * 3]     * a);
    finalRaw[i * 3 + 1] = Math.round(origFull[i * 3 + 1] * (1 - a) + lamaFull[i * 3 + 1] * a);
    finalRaw[i * 3 + 2] = Math.round(origFull[i * 3 + 2] * (1 - a) + lamaFull[i * 3 + 2] * a);
  }

  return sharp(finalRaw, { raw: { width: W, height: H, channels: 3 } })
    .png()
    .toBuffer();
  } catch (err) {
    logToFile(`ERROR in runLaMa: ${err.message}`);
    logToFile(`STACK: ${err.stack}`);
    throw err;
  }
}

// ─── Public: remove object with a painted mask ───────────────────────────────

export async function removeObjectWithMask(assetId, userId, { maskDataUrl, mode = 'new', newName }) {
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: assetId, userId, deletedAt: null },
  });
  if (!asset) throw createAppError('Asset not found', 404, 'NOT_FOUND');
  if (asset.type !== 'IMAGE') {
    throw createAppError('Object removal only supports images currently.', 400, 'UNSUPPORTED_TYPE');
  }
  if (!maskDataUrl || !maskDataUrl.startsWith('data:image')) {
    throw createAppError('A valid mask image is required.', 400, 'INVALID_MASK');
  }

  logToFile('=== Object removal started ===');
  logToFile(`Asset: ${asset.id}, image URL: ${asset.cloudinarySecureUrl}`);

  // 1. Get image + mask buffers
  let imageBuffer, maskBuffer;
  try {
    logToFile('Fetching original image...');
    imageBuffer = await fetchImageBuffer(asset.cloudinarySecureUrl);
    logToFile(`Image fetched: ${imageBuffer.length} bytes`);
    maskBuffer = dataUrlToBuffer(maskDataUrl);
    logToFile(`Mask decoded: ${maskBuffer.length} bytes`);
  } catch (err) {
    logToFile(`ERROR fetching image/mask: ${err.message}`);
    logToFile(`STACK: ${err.stack}`);
    throw err;
  }

  // 2. Run LaMa locally
  const resultBuffer = await runLaMa(imageBuffer, maskBuffer);
  logToFile(`LaMa done, result: ${resultBuffer.length} bytes`);

  // 3. Save result to temp + upload to Cloudinary
  const tmpPath = path.join(getTempDir(), `lama_${uuidv4()}.png`);
  fs.writeFileSync(tmpPath, resultBuffer);

  try {
    const folder    = getFolder(userId, 'images');
    const baseName  = asset.name.replace(/\.[^.]+$/, '');
    const ext       = asset.name.match(/\.[^.]+$/)?.[0] || '.png';
    const finalName = newName || `${baseName}_removed${ext}`;

    const uploadResult = await new Promise((resolve, reject) => {
      const opts = mode === 'replace'
        ? { public_id: asset.cloudinaryPublicId, resource_type: 'image', overwrite: true, invalidate: true }
        : { folder, resource_type: 'image', overwrite: false };
      cloudinary.uploader.upload(tmpPath, opts, (err, res) => err ? reject(err) : resolve(res));
    });

    const newSizeMb = bytesToMb(uploadResult.bytes || 0);
    let savedAsset;

    if (mode === 'replace') {
      savedAsset = await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          cloudinaryUrl:       uploadResult.url,
          cloudinarySecureUrl: uploadResult.secure_url,
          width:               uploadResult.width  || asset.width,
          height:              uploadResult.height || asset.height,
          fileSizeMb:          newSizeMb,
          updatedAt:           new Date(),
        },
      });
      const delta = newSizeMb - (asset.fileSizeMb || 0);
      if (delta !== 0) await incrementStorageUsage(userId, delta);
    } else {
      savedAsset = await prisma.mediaAsset.create({
        data: {
          userId,
          type:                'IMAGE',
          name:                finalName,
          mimeType:            'image/png',
          cloudinaryPublicId:  uploadResult.public_id,
          cloudinaryUrl:       uploadResult.url,
          cloudinarySecureUrl: uploadResult.secure_url,
          width:               uploadResult.width  || asset.width,
          height:              uploadResult.height || asset.height,
          fileSizeMb:          newSizeMb,
          thumbnailUrl:        asset.thumbnailUrl,
          thumbnailPublicId:   asset.thumbnailPublicId,
        },
      });
      await incrementStorageUsage(userId, newSizeMb);
    }

    console.log(`[LaMa] Saved as ${savedAsset.id} (mode: ${mode})`);
    return { asset: savedAsset, mode };

  } finally {
    cleanTempFile(tmpPath);
  }
}