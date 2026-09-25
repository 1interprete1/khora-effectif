"""Khora Effectif local transcription worker.

Captures Windows shared-mode microphone and speaker loopback. It never imports,
injects into, or controls Effectif/Chrome. Audio and transcript remain in RAM.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import threading
import time
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx
import numpy as np
import soundcard as sc
import websockets
from faster_whisper import WhisperModel

HOST = "127.0.0.1"
PORT = 8765
WORKER_VERSION = "0.6.0"
PROTOCOL_VERSION = 3
SAMPLE_RATE = 16000
CHUNK_SECONDS = 2.4
CHUNK_FRAMES = int(SAMPLE_RATE * CHUNK_SECONDS)
VOICE_RMS = 0.006
GROQ_RATE_PER_HOUR = 0.04
WORKER_TOKEN = "f403c72c031c5a26f786f847bb8459ee64bdd234727e657f579623a0dd447fd6"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clean_audio(samples: np.ndarray) -> np.ndarray:
    audio = np.asarray(samples, dtype=np.float32)
    if audio.ndim == 2:
        audio = np.mean(audio, axis=1)
    return np.clip(audio.reshape(-1), -1.0, 1.0)


def wav_bytes(audio: np.ndarray) -> bytes:
    output = io.BytesIO()
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())
    return output.getvalue()


@dataclass
class Job:
    speaker: str
    audio: np.ndarray
    captured_at: str


class Engine:
    def __init__(self) -> None:
        self.clients: set[Any] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.jobs: asyncio.Queue[Job] = asyncio.Queue(maxsize=24)
        self.active = threading.Event()
        self.capture_threads: list[threading.Thread] = []
        self.model: WhisperModel | None = None
        self.model_loading = False
        self.model_error: str | None = None
        self.mode = "auto"
        self.api_key = ""
        self.local_model = "large-v3-turbo"
        self.groq_model = "whisper-large-v3-turbo"
        self.call_id: str | None = None
        self.microphone_id = ""
        self.speaker_id = ""
        self.metrics = {
            "segments": 0,
            "localSegments": 0,
            "groqSegments": 0,
            "errors": 0,
            "queueDepth": 0,
            "totalLatencyMs": 0,
            "averageLatencyMs": 0,
            "groqBilledSeconds": 0.0,
            "groqEstimatedUsd": 0.0,
        }

    async def broadcast(self, payload: dict[str, Any]) -> None:
        message = json.dumps(payload, ensure_ascii=False)
        dead = []
        for client in tuple(self.clients):
            try:
                await client.send(message)
            except Exception:
                dead.append(client)
        for client in dead:
            self.clients.discard(client)

    async def status(self, phase: str, **extra: Any) -> None:
        await self.broadcast({
            "type": "status",
            "phase": phase,
            "timestamp": now_iso(),
            "platformAudioAccess": False,
            "platformAudioModified": False,
            "captureLayer": "windows-shared-audio",
            "workerVersion": WORKER_VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            **extra,
        })

    def device_inventory(self) -> dict[str, Any]:
        microphones = [
            {"id": str(device.id), "name": str(device.name)}
            for device in sc.all_microphones(include_loopback=False)
        ]
        speakers = [
            {"id": str(device.id), "name": str(device.name)}
            for device in sc.all_speakers()
        ]
        return {
            "inputDevices": microphones,
            "outputDevices": speakers,
            "defaultMicrophone": str(sc.default_microphone()),
            "defaultSpeaker": str(sc.default_speaker()),
        }

    @staticmethod
    def select_device(devices: list[Any], requested_id: str, fallback: Any) -> Any:
        if requested_id:
            for device in devices:
                if str(device.id) == requested_id:
                    return device
        return fallback

    def load_model_blocking(self) -> None:
        if self.model or self.model_loading:
            return
        self.model_loading = True
        try:
            self.model = WhisperModel(
                self.local_model,
                device="cuda",
                compute_type="int8_float16",
            )
            self.model_error = None
        except Exception as gpu_error:
            self.model_error = f"CUDA no disponible: {gpu_error}"
            try:
                self.model = WhisperModel(
                    "small",
                    device="cpu",
                    compute_type="int8",
                )
                self.model_error = f"{self.model_error}; respaldo CPU small activo"
            except Exception as cpu_error:
                self.model = None
                self.model_error = f"{self.model_error}; CPU falló: {cpu_error}"
        finally:
            self.model_loading = False

    async def ensure_model(self) -> None:
        if self.model or self.model_loading:
            return
        await self.status("model-loading", engine="local", model=self.local_model)
        await asyncio.to_thread(self.load_model_blocking)
        if self.model:
            await self.status(
                "model-ready",
                engine="local",
                model=self.local_model if "CPU" not in str(self.model_error) else "small",
                warning=self.model_error,
            )
        else:
            await self.status("model-error", engine="groq", error=self.model_error)

    def capture_device(self, speaker: str, microphone: Any) -> None:
        try:
            with microphone.recorder(samplerate=SAMPLE_RATE) as recorder:
                while self.active.is_set():
                    audio = clean_audio(recorder.record(numframes=CHUNK_FRAMES))
                    if not self.active.is_set():
                        break
                    rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
                    if rms < VOICE_RMS:
                        continue
                    job = Job(speaker=speaker, audio=audio, captured_at=now_iso())
                    if self.loop:
                        self.loop.call_soon_threadsafe(self.enqueue_job, job)
        except Exception as error:
            if self.loop:
                asyncio.run_coroutine_threadsafe(
                    self.status(
                        "capture-error",
                        speaker=speaker,
                        error=str(error),
                        platformAudioModified=False,
                    ),
                    self.loop,
                )

    def enqueue_job(self, job: Job) -> None:
        try:
            self.jobs.put_nowait(job)
        except asyncio.QueueFull:
            self.metrics["errors"] += 1

    async def start_capture(self) -> None:
        if self.active.is_set():
            return
        self.active.set()
        self.loop = asyncio.get_running_loop()
        microphone = self.select_device(
            list(sc.all_microphones(include_loopback=False)),
            self.microphone_id,
            sc.default_microphone(),
        )
        speaker = self.select_device(
            list(sc.all_speakers()),
            self.speaker_id,
            sc.default_speaker(),
        )
        if microphone is None or speaker is None:
            self.active.clear()
            raise RuntimeError("No se encontraron micrófono y altavoz predeterminados")
        loopback = sc.get_microphone(id=str(speaker.id), include_loopback=True)
        if loopback is None:
            self.active.clear()
            raise RuntimeError("Windows no expuso la captura compartida del altavoz")
        self.capture_threads = [
            threading.Thread(
                target=self.capture_device,
                args=("interpreter", microphone),
                daemon=True,
                name="khora-microphone-copy",
            ),
            threading.Thread(
                target=self.capture_device,
                args=("client", loopback),
                daemon=True,
                name="khora-speaker-loopback",
            ),
        ]
        for thread in self.capture_threads:
            thread.start()
        await self.status(
            "capturing",
            connected=True,
            engine="local" if self.model else "groq",
            microphone=str(microphone.name),
            speaker=str(speaker.name),
            microphoneId=str(microphone.id),
            speakerId=str(speaker.id),
        )

    async def run_test(self) -> None:
        await self.stop_capture("pre-test-reset")
        await self.start_capture()
        await self.status("test-running", connected=True, seconds=10)
        await asyncio.sleep(10)
        await self.stop_capture("test-complete")

    async def stop_capture(self, reason: str) -> None:
        self.active.clear()
        self.capture_threads = []
        while not self.jobs.empty():
            try:
                self.jobs.get_nowait()
                self.jobs.task_done()
            except asyncio.QueueEmpty:
                break
        await self.status("stopped", connected=True, reason=reason)

    def transcribe_local(self, audio: np.ndarray) -> str:
        if not self.model:
            raise RuntimeError("Modelo local no disponible")
        segments, _ = self.model.transcribe(
            audio,
            language=None,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            temperature=0.0,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()

    async def transcribe_groq(self, audio: np.ndarray) -> str:
        if not self.api_key:
            raise RuntimeError("Groq no está configurado")
        files = {"file": ("effectif.wav", wav_bytes(audio), "audio/wav")}
        data = {
            "model": self.groq_model,
            "response_format": "json",
            "temperature": "0",
            "prompt": "Bilingual English and Spanish medical interpretation. Preserve medical terms.",
        }
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                "https://api.groq.com/openai/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                files=files,
                data=data,
            )
            response.raise_for_status()
            return str(response.json().get("text", "")).strip()

    async def process_jobs(self) -> None:
        while True:
            job = await self.jobs.get()
            self.metrics["queueDepth"] = self.jobs.qsize()
            started = time.perf_counter()
            engine = "local"
            text = ""
            try:
                if self.mode != "groq" and not self.model and not self.model_loading:
                    asyncio.create_task(self.ensure_model())
                if self.mode == "local":
                    if not self.model:
                        await self.ensure_model()
                    text = await asyncio.to_thread(self.transcribe_local, job.audio)
                elif self.mode == "groq":
                    engine = "groq"
                    text = await self.transcribe_groq(job.audio)
                elif self.model:
                    text = await asyncio.to_thread(self.transcribe_local, job.audio)
                else:
                    engine = "groq"
                    text = await self.transcribe_groq(job.audio)
                latency_ms = round((time.perf_counter() - started) * 1000)
                if text:
                    self.metrics["segments"] += 1
                    self.metrics["localSegments" if engine == "local" else "groqSegments"] += 1
                    self.metrics["totalLatencyMs"] += latency_ms
                    self.metrics["averageLatencyMs"] = round(
                        self.metrics["totalLatencyMs"] / self.metrics["segments"]
                    )
                    if engine == "groq":
                        self.metrics["groqBilledSeconds"] += max(10.0, len(job.audio) / SAMPLE_RATE)
                        self.metrics["groqEstimatedUsd"] = round(
                            self.metrics["groqBilledSeconds"] / 3600 * GROQ_RATE_PER_HOUR,
                            6,
                        )
                    await self.broadcast({
                        "type": "transcript",
                        "speaker": job.speaker,
                        "text": text,
                        "engine": engine,
                        "latencyMs": latency_ms,
                        "capturedAt": job.captured_at,
                        "timestamp": now_iso(),
                    })
            except Exception as error:
                self.metrics["errors"] += 1
                await self.status(
                    "transcription-error",
                    engine=engine,
                    speaker=job.speaker,
                    error=str(error),
                )
            finally:
                self.metrics["queueDepth"] = self.jobs.qsize()
                await self.broadcast({"type": "metrics", **self.metrics, "timestamp": now_iso()})
                self.jobs.task_done()

    async def handle(self, websocket: Any) -> None:
        authenticated = False
        try:
            async for raw in websocket:
                message = json.loads(raw)
                kind = message.get("type")
                if not authenticated:
                    if kind != "auth" or message.get("token") != WORKER_TOKEN:
                        await websocket.close(code=4003, reason="unauthorized")
                        return
                    authenticated = True
                    self.clients.add(websocket)
                    await websocket.send(json.dumps({
                        "type": "status",
                        "phase": "worker-authenticated",
                        "connected": True,
                        "platformAudioAccess": False,
                        "platformAudioModified": False,
                        "workerVersion": WORKER_VERSION,
                        "protocolVersion": PROTOCOL_VERSION,
                        "timestamp": now_iso(),
                    }))
                    continue
                if kind == "probe":
                    asyncio.create_task(self.ensure_model())
                    await self.status(
                        "probe-ok",
                        connected=True,
                        modelReady=bool(self.model),
                        modelError=self.model_error,
                        **self.device_inventory(),
                    )
                elif kind == "start":
                    self.call_id = str(message.get("callId") or "")
                    self.mode = str(message.get("mode") or "auto")
                    self.api_key = str(message.get("apiKey") or "")
                    self.local_model = str(message.get("localModel") or "large-v3-turbo")
                    self.groq_model = str(message.get("groqModel") or "whisper-large-v3-turbo")
                    self.microphone_id = str(message.get("microphoneId") or "")
                    self.speaker_id = str(message.get("speakerId") or "")
                    asyncio.create_task(self.ensure_model())
                    try:
                        await self.start_capture()
                    except Exception as error:
                        await self.status("capture-start-error", connected=True, error=str(error))
                elif kind == "test":
                    self.mode = str(message.get("mode") or "auto")
                    self.api_key = str(message.get("apiKey") or "")
                    self.local_model = str(message.get("localModel") or "large-v3-turbo")
                    self.groq_model = str(message.get("groqModel") or "whisper-large-v3-turbo")
                    self.microphone_id = str(message.get("microphoneId") or "")
                    self.speaker_id = str(message.get("speakerId") or "")
                    asyncio.create_task(self.ensure_model())
                    asyncio.create_task(self.run_test())
                elif kind == "stop":
                    await self.stop_capture(str(message.get("reason") or "requested"))
        finally:
            self.clients.discard(websocket)


async def run_server() -> None:
    engine = Engine()
    asyncio.create_task(engine.process_jobs())
    async with websockets.serve(engine.handle, HOST, PORT, max_size=1_000_000):
        print(f"KHORA_EFFECTIF_WORKER_READY ws://{HOST}:{PORT}", flush=True)
        await asyncio.Future()


def self_test() -> int:
    print("KHORA · Effectif · prueba local")
    print(f"Micrófono: {sc.default_microphone()}")
    print(f"Altavoz: {sc.default_speaker()}")
    engine = Engine()
    engine.load_model_blocking()
    if engine.model:
        print(f"WHISPER_READY model={engine.local_model} warning={engine.model_error}")
        return 0
    print(f"WHISPER_NOT_READY {engine.model_error}")
    return 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    arguments = parser.parse_args()
    raise SystemExit(self_test() if arguments.self_test else asyncio.run(run_server()))