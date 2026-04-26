import io
import json
import os
import numpy as np
import soundfile as sf
import torch
import torchaudio

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from speechbrain.inference.speaker import EncoderClassifier

app = FastAPI(title="Notemint Voice Service", version="1.0.0")

MODEL_SOURCE = os.getenv("SPEECHBRAIN_MODEL_SOURCE", "speechbrain/spkrec-ecapa-voxceleb")
MIN_DURATION_SEC = float(os.getenv("MIN_DURATION_SEC", "1.5"))

classifier = EncoderClassifier.from_hparams(
    source=MODEL_SOURCE,
    savedir="model_cache"
)

def normalize_vector(vec: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vec)
    if norm == 0:
        return vec
    return vec / norm

def load_audio(raw: bytes):
    try:
        data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read audio: {str(e)}")

    if isinstance(data, np.ndarray) and data.ndim > 1:
        data = data.mean(axis=1)

    waveform = torch.tensor(data, dtype=torch.float32).unsqueeze(0)

    if sr != 16000:
        waveform = torchaudio.functional.resample(waveform, sr, 16000)
        sr = 16000

    duration_sec = waveform.shape[1] / sr

    if duration_sec < MIN_DURATION_SEC:
        raise HTTPException(
            status_code=400,
            detail=f"Audio too short. Need at least {MIN_DURATION_SEC:.1f}s."
        )

    return waveform, sr, duration_sec

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/embed")
async def embed(audio: UploadFile = File(...)):
    raw = await audio.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio file")

    waveform, sr, duration_sec = load_audio(raw)

    with torch.no_grad():
        embedding = classifier.encode_batch(waveform)

    embedding = embedding.squeeze().cpu().numpy().astype(np.float32)
    embedding = normalize_vector(embedding)

    return {
        "embedding": embedding.tolist(),
        "dimensions": int(embedding.shape[0]),
        "duration_sec": round(float(duration_sec), 3)
    }

@app.post("/score")
async def score(
    audio: UploadFile = File(...),
    reference_embedding_json: str = Form(...)
):
    raw = await audio.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio file")

    try:
        reference = np.array(json.loads(reference_embedding_json), dtype=np.float32)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid reference embedding JSON")

    reference = normalize_vector(reference)

    waveform, sr, duration_sec = load_audio(raw)

    with torch.no_grad():
        query = classifier.encode_batch(waveform)

    query = query.squeeze().cpu().numpy().astype(np.float32)
    query = normalize_vector(query)

    score = float(np.dot(query, reference))

    return {
        "score": round(score, 6),
        "duration_sec": round(float(duration_sec), 3)
    }
