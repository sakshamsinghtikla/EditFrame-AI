from fastapi.testclient import TestClient


def test_root(client: TestClient) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["docs"] == "/docs"


def test_ffmpeg_health_contract(client: TestClient) -> None:
    response = client.get("/api/v1/video/ffmpeg/health")
    assert response.status_code == 200
    assert {"ready", "ffmpeg", "ffprobe"} <= response.json().keys()


def test_sam2_health_does_not_force_model_load(client: TestClient) -> None:
    response = client.get("/api/v1/ai/sam2/health")
    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "sam2.1_hiera_tiny"
    assert "checkpoint_exists" in body


def test_lama_health_does_not_force_model_load(client: TestClient) -> None:
    response = client.get("/api/v1/ai/lama/health")
    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "lama_fp32.onnx"
    assert body["provider"] == "CPUExecutionProvider"
    assert "checkpoint_exists" in body
