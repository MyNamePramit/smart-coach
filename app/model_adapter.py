# app/model_adapter.py
import os
import time

from openai import OpenAI, AzureOpenAI

OPENAI_API_KEY     = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_BASE_URL    = os.environ.get("OPENAI_BASE_URL", "").strip()
OPENAI_API_VERSION = os.environ.get("OPENAI_API_VERSION", "2024-02-01").strip()
_IS_AZURE          = ".openai.azure.com" in OPENAI_BASE_URL
_raw_model         = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_MODEL       = _raw_model.removeprefix("azure/") if _IS_AZURE else _raw_model
OPENAI_TIMEOUT_S   = float(os.environ.get("OPENAI_TIMEOUT_S", "60"))
OPENAI_MAX_RETRIES = 1

TTS_MODEL       = os.environ.get("TTS_MODEL", "tts-1-hd")
TTS_VOICE       = os.environ.get("TTS_VOICE", "alloy")
USE_LOCAL_TTS   = os.environ.get("USE_LOCAL_TTS", "0").lower() in {"1", "true", "yes"}
TTS_LOCAL_VOICE = os.environ.get("TTS_LOCAL_VOICE", "af_heart")

# Separate TTS credentials — lets you use Groq (or any provider) for LLM
# while still hitting standard OpenAI for TTS.
# If TTS_API_KEY is unset, TTS falls back to OPENAI_API_KEY (original behaviour).
TTS_API_KEY  = os.environ.get("TTS_API_KEY", "").strip() or OPENAI_API_KEY
TTS_BASE_URL = os.environ.get("TTS_BASE_URL", "").strip()  # empty = standard OpenAI

_REASONING_PREFIXES = ("o1", "o3", "o4")

def _is_reasoning_model(name: str) -> bool:
    return any(name.lower().startswith(p) for p in _REASONING_PREFIXES)


class ModelAdapter:
    def __init__(self):
        self.openai_model = OPENAI_MODEL

        self._kokoro = None
        if USE_LOCAL_TTS:
            try:
                from kokoro import KPipeline
                self._kokoro = KPipeline(lang_code='a')
                import soundfile as sf, numpy as np, tempfile, os as _os
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp_path = tmp.name
                try:
                    chunks = [a for _, _, a in self._kokoro("Hi.", voice=TTS_LOCAL_VOICE, speed=1.0)]
                    sf.write(tmp_path, np.concatenate(chunks), 24000)
                finally:
                    _os.unlink(tmp_path)
                print(f"[ModelAdapter] Kokoro TTS ready and warmed (voice={TTS_LOCAL_VOICE})")
            except Exception as exc:
                print(f"[ModelAdapter] Kokoro TTS init failed, will fall back to OpenAI TTS: {exc}")

        if not OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is not set.")
        if _IS_AZURE:
            self.openai_client = AzureOpenAI(
                api_key=OPENAI_API_KEY,
                azure_endpoint=OPENAI_BASE_URL,
                api_version=OPENAI_API_VERSION,
            )
            print(f"[ModelAdapter] Using Azure OpenAI deployment '{self.openai_model}' at {OPENAI_BASE_URL}")
        else:
            client_kwargs = {"api_key": OPENAI_API_KEY}
            if OPENAI_BASE_URL:
                client_kwargs["base_url"] = OPENAI_BASE_URL
            self.openai_client = OpenAI(**client_kwargs)
            provider = "OpenAI-compatible endpoint" if OPENAI_BASE_URL else "OpenAI"
            print(f"[ModelAdapter] Using {provider} model '{self.openai_model}'")

        # Separate TTS client — always points at standard OpenAI (or TTS_BASE_URL if set).
        # This lets the LLM client use Groq/Azure while TTS still uses OpenAI audio API.
        if not USE_LOCAL_TTS and not _IS_AZURE:
            tts_kwargs: dict = {"api_key": TTS_API_KEY}
            if TTS_BASE_URL:
                tts_kwargs["base_url"] = TTS_BASE_URL
            self.tts_client = OpenAI(**tts_kwargs)
        else:
            self.tts_client = self.openai_client  # Azure or local — no separate client needed

    def _create(self, **kwargs):
        """Shared retry wrapper for chat completions."""
        last_exc = None
        for attempt in range(OPENAI_MAX_RETRIES + 1):
            try:
                return self.openai_client.chat.completions.create(**kwargs)
            except Exception as exc:
                last_exc = exc
            if attempt < OPENAI_MAX_RETRIES:
                time.sleep(1)
        raise RuntimeError(f"OpenAI request failed: {last_exc}")

    def generate(self, system_prompt, conversation_history, max_new_tokens=400, temperature=0.2):
        tokens = max(max_new_tokens, 8000) if _is_reasoning_model(self.openai_model) else max_new_tokens
        kwargs = dict(
            model=self.openai_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"CONVERSATION:\n{conversation_history}\nAI:"},
            ],
            max_completion_tokens=tokens,
            timeout=OPENAI_TIMEOUT_S,
        )
        if not _is_reasoning_model(self.openai_model):
            kwargs["temperature"] = temperature
        resp = self._create(**kwargs)
        return (resp.choices[0].message.content or "").strip()

    def generate_stream(self, system_prompt, conversation_history, max_new_tokens=400, temperature=0.2):
        """Yields text chunks via OpenAI streaming."""
        tokens = max(max_new_tokens, 8000) if _is_reasoning_model(self.openai_model) else max_new_tokens
        kwargs = dict(
            model=self.openai_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"CONVERSATION:\n{conversation_history}\nAI:"},
            ],
            max_completion_tokens=tokens,
            timeout=OPENAI_TIMEOUT_S,
            stream=True,
        )
        if not _is_reasoning_model(self.openai_model):
            kwargs["temperature"] = temperature
        stream = self.openai_client.chat.completions.create(**kwargs)
        for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                yield delta

    def complete(self, system_prompt: str, user_prompt: str, max_tokens: int = 16, temperature: float = 0.0) -> str:
        """Direct completion — no CONVERSATION wrapper, no json_object format. For YES/NO checks."""
        kwargs = dict(
            model=self.openai_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_completion_tokens=max_tokens,
            timeout=OPENAI_TIMEOUT_S,
            temperature=temperature,
        )
        if _is_reasoning_model(self.openai_model):
            kwargs.pop("temperature", None)
        resp = self._create(**kwargs)
        return (resp.choices[0].message.content or "").strip()

    def judge(self, system_prompt: str, user_prompt: str, max_tokens: int = 512) -> str:
        """Deterministic JSON call for LLM-as-judge tasks."""
        kwargs = dict(
            model=self.openai_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_completion_tokens=max_tokens,
            timeout=OPENAI_TIMEOUT_S,
            temperature=0.0,
        )
        if not _is_reasoning_model(self.openai_model):
            kwargs["response_format"] = {"type": "json_object"}
        else:
            kwargs.pop("temperature", None)
        resp = self._create(**kwargs)
        return (resp.choices[0].message.content or "").strip()

    def synthesize_speech(self, text: str, output_path: str, voice: str | None = None) -> str:
        if self._kokoro is not None:
            import numpy as np
            import soundfile as sf
            wav_path = os.path.splitext(output_path)[0] + ".wav"
            chunks = [audio for _, _, audio in self._kokoro(text, voice=voice or TTS_LOCAL_VOICE, speed=1.0)]
            sf.write(wav_path, np.concatenate(chunks), 24000)
            return wav_path

        response = self.tts_client.audio.speech.create(
            model=TTS_MODEL,
            voice=voice or TTS_VOICE,
            input=text,
            response_format="mp3",
        )
        response.stream_to_file(output_path)
        return output_path
