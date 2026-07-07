# test_track.py — verify the /track endpoint end to end.
# Usage:
#   python test_track.py "<frames_dir>" <source_frame> <x> <y>
# Example (use a jobId folder from a Sprint-4 extraction):
#   python test_track.py "C:/Users/tarun/AppData/Local/Temp/editframe-temp/<jobId>" 0 960 540
#
# It calls the running SAM 2 service, then reports how many mask PNGs were written.

import sys
import glob
import os
import requests

if len(sys.argv) < 5:
    print("Usage: python test_track.py \"<frames_dir>\" <source_frame> <x> <y>")
    sys.exit(1)

frames_dir  = sys.argv[1]
source_frame = int(sys.argv[2])
x, y = float(sys.argv[3]), float(sys.argv[4])

png_count = len(glob.glob(os.path.join(frames_dir, "frame_*.png")))
print(f"\n📁 frames_dir has {png_count} frames")
print(f"🖱️  clicking ({x}, {y}) on frame {source_frame}")
print("⏳ tracking (first run also converts frames to JPEG — be patient)…\n")

resp = requests.post("http://127.0.0.1:5001/track", json={
    "frames_dir":   frames_dir,
    "source_frame": source_frame,
    "points":       [[x, y]],
    "labels":       [1],
    "obj_id":       1,
}, timeout=1800)

if resp.status_code != 200:
    print(f"❌ {resp.status_code}: {resp.text}")
    sys.exit(1)

data = resp.json()
masks = sorted(glob.glob(os.path.join(data["masks_dir"], "mask_*.png")))
print("✅ Tracking complete!")
print(f"   tracked_frames: {data['tracked_frames']} / {data['total_frames']}")
print(f"   masks written:  {len(masks)} → {data['masks_dir']}")
print(f"   first masks:    {[os.path.basename(m) for m in masks[:3]]}")
print("\n👀 Open a few mask_*.png files — the object should be white, moving frame to frame.\n")