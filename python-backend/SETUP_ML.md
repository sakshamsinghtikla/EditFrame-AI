# SAM 2 worker setup

The base API image intentionally does not install PyTorch or SAM 2. This keeps ordinary API startup lightweight and avoids installing a CUDA-incompatible PyTorch build.

## 1. Install PyTorch

Install the PyTorch build that matches the machine's CUDA version by following the official PyTorch installation selector.

For CPU-only development, install the CPU build instead. Tracking will work but will be substantially slower.

## 2. Install SAM 2

From the activated Python environment:

```bash
pip install git+https://github.com/facebookresearch/sam2.git
```

## 3. Add the checkpoint

Create the model directory:

```bash
mkdir -p models
```

Place the SAM 2.1 Hiera Tiny checkpoint at:

```text
models/sam2.1_hiera_tiny.pt
```

The location can be changed with `SAM2_CHECKPOINT`.

## 4. Start the worker

```bash
celery -A app.tasks.celery_app.celery_app worker --loglevel=INFO --concurrency=1
```

Use a concurrency of one for a single GPU unless memory profiling proves that parallel model instances are safe.

## 5. Verify configuration

```bash
curl http://localhost:8000/api/v1/ai/sam2/health
```

The endpoint reports the configured model, checkpoint existence, and whether the model has been loaded by the current process. The worker loads the model lazily when the first segmentation or tracking job runs.
