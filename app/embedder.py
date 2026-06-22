# app/embedder.py
import numpy as np
import os
from openai import AzureOpenAI, OpenAI

OPENAI_API_KEY     = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_BASE_URL    = os.environ.get("OPENAI_BASE_URL", "").strip()
OPENAI_API_VERSION = os.environ.get("OPENAI_API_VERSION", "2024-02-01").strip()
_IS_AZURE          = ".openai.azure.com" in OPENAI_BASE_URL
EMBED_MODEL        = os.environ.get("OPENAI_EMBED_MODEL", "text-embedding-3-small")
ST_MODEL           = os.environ.get("ST_EMBED_MODEL", "BAAI/bge-small-en-v1.5")


class Embedder:
    """
    Tries Azure/OpenAI embeddings first.  If the deployment isn't available
    (missing model, 404, or any error on the first probe call) it falls back
    to a local SentenceTransformer model.

    Exposes encode(texts) -> np.ndarray (L2-normalised, float32) to match
    the SentenceTransformer interface used across the codebase.
    """

    def __init__(self):
        self._st = None

        if _IS_AZURE:
            self._client = AzureOpenAI(
                api_key=OPENAI_API_KEY,
                azure_endpoint=OPENAI_BASE_URL,
                api_version=OPENAI_API_VERSION,
            )
        else:
            client_kwargs = {"api_key": OPENAI_API_KEY}
            if OPENAI_BASE_URL:
                client_kwargs["base_url"] = OPENAI_BASE_URL
            self._client = OpenAI(**client_kwargs)

        # Probe with a single short text to confirm the deployment exists.
        try:
            self._client.embeddings.create(model=EMBED_MODEL, input=["ping"])
            print(f"[Embedder] Using {'Azure ' if _IS_AZURE else ''}OpenAI embeddings '{EMBED_MODEL}'")
        except Exception as exc:
            print(f"[Embedder] OpenAI embedding probe failed ({exc}); falling back to SentenceTransformer '{ST_MODEL}'")
            self._client = None
            self._load_st()

    def _load_st(self):
        from sentence_transformers import SentenceTransformer
        self._st = SentenceTransformer(ST_MODEL)
        print(f"[Embedder] SentenceTransformer '{ST_MODEL}' loaded")

    def encode(self, texts: list[str], is_query: bool = False, **_kwargs) -> np.ndarray:
        """
        Embed a list of strings. Returns float32 (N, dim), L2-normalised.
        is_query=True applies BGE query prefix for better retrieval accuracy.
        """
        if not texts:
            return np.zeros((0, 384), dtype=np.float32)

        if self._st is not None:
            # BGE models need a prefix for query-side encoding
            _texts = [f"Represent this sentence for searching relevant passages: {t}" for t in texts] if is_query else texts
            vecs = self._st.encode(_texts, convert_to_numpy=True, show_progress_bar=False)
        else:
            try:
                resp = self._client.embeddings.create(model=EMBED_MODEL, input=texts)
                vecs = np.array([d.embedding for d in resp.data], dtype=np.float32)
            except Exception as exc:
                # Runtime failure — switch to ST for the rest of the session
                print(f"[Embedder] OpenAI embedding call failed ({exc}); switching to SentenceTransformer")
                self._client = None
                self._load_st()
                vecs = self._st.encode(texts, convert_to_numpy=True, show_progress_bar=False)

        vecs = np.array(vecs, dtype=np.float32)
        norms = np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-10
        return vecs / norms
