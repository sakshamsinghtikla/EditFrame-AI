# ML worker setup

The base API image installs ONNX Runtime for LaMa but intentionally does not install PyTorch or SAM 2. PyTorch must match the machine's CUDA version.

## SAM 2

### 1. Install PyTorch

Install the PyTorch build that matches the machine's CUDA version. For CPU-only development, install the CPU build instead; tracking will be much slower.

### 2. Install SAM 2

```bash
pip install git+https://github.com/facebookresearch/sam2.git
```

### 3. Add the checkpoint

```bash
mkdir -p models
```

Place the SAM 2.1 Hiera Tiny checkpoint at:

```text
models/sam2.1_hiera_tiny.pt
```

The location can be changed with `SAM2_CHECKPOINT`.

## LaMa

Place the ONNX checkpoint at:

```text
models/lama_fp32.onnx
```

The location can be changed with `LAMA_CHECKPOINT`. The baseline provider is `CPUExecutionProvider`; override `LAMA_EXECUTION_PROVIDER` only when the installed ONNX Runtime build supports the selected provider.

## Start the worker

```bash
celery -A app.tasks.celery_app.celery_app worker --loglevel=INFO --concurrency=1
```

Use concurrency one on a single GPU unless memory profiling proves that multiple model tasks are safe.

## Verify configuration

```bash
curl http://localhost:8000/api/v1/ai/sam2/health
curl http://localhost:8000/api/v1/ai/lama/health
```

Both models load lazily when their first worker task runs. Health endpoints report configuration and checkpoint availability without forcing model initialization.
