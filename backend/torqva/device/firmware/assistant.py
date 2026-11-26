"""Bounded, opt-in firmware engineering assistant using an OpenAI-compatible provider.

The assistant cannot write files, call deployment APIs, access signing keys or issue device commands.
No request leaves the backend unless the operator explicitly consents and a provider is configured.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Dict

MAX_CONTEXT = 40_000
TASKS = {"explain", "compile_error", "code_review", "compatibility", "crash_analysis", "memory", "performance", "security", "safety", "compare", "release_notes", "troubleshoot"}


class AssistantError(Exception):
    def __init__(self, code: str, detail: str, status: int = 400):
        super().__init__(detail); self.code, self.detail, self.status = code, detail, status


class FirmwareAssistant:
    def __init__(self) -> None:
        self.base_url = os.environ.get("TORQVA_AI_BASE_URL", "").rstrip("/")
        self.api_key = os.environ.get("TORQVA_AI_API_KEY", "")
        self.model = os.environ.get("TORQVA_AI_MODEL", "")
        self.timeout = min(120, max(5, int(os.environ.get("TORQVA_AI_TIMEOUT_S", "45"))))

    def status(self) -> Dict[str, Any]:
        configured = bool(self.base_url and self.api_key and self.model)
        return {"available": configured, "provider": "OpenAI-compatible" if configured else None, "model": self.model or None,
                "detail": "Provider configured; source is sent only after explicit consent." if configured else "No AI provider is configured. Set TORQVA_AI_BASE_URL, TORQVA_AI_API_KEY and TORQVA_AI_MODEL on the backend."}

    @staticmethod
    def _redact(value: str) -> str:
        value = re.sub(r"(?i)(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s\"']+", r"\1=[REDACTED]", value)
        value = re.sub(r"-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----", "[PRIVATE KEY REDACTED]", value)
        return value[:MAX_CONTEXT]

    def analyze(self, task: str, context: str, consent_external: bool) -> Dict[str, Any]:
        if task not in TASKS:
            raise AssistantError("BAD_TASK", f"unsupported assistant task {task!r}")
        if not self.status()["available"]:
            raise AssistantError("AI_UNAVAILABLE", self.status()["detail"], 503)
        if not consent_external:
            raise AssistantError("CONSENT_REQUIRED", "explicit authorization is required before transmitting source code or logs to the configured AI provider", 409)
        clean = self._redact(context)
        if not clean.strip():
            raise AssistantError("EMPTY_CONTEXT", "select source code, build diagnostics or logs to analyze")
        system = ("You are TORQVA's firmware review assistant. Use only supplied evidence. Separate confirmed findings from hypotheses. "
                  "Cite evidence as file:line or log line where possible. Return practical review guidance and a unified diff only when a change is justified. "
                  "Never claim deployment, modify safety limits, reveal secrets, approve firmware, or suggest bypassing signature, compatibility, authorization or motor protections.")
        payload = json.dumps({"model": self.model, "temperature": 0.1, "messages": [{"role": "system", "content": system},
                            {"role": "user", "content": f"Task: {task}\nEvidence:\n{clean}"}]}).encode()
        req = urllib.request.Request(f"{self.base_url}/chat/completions", data=payload, method="POST",
                                     headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                raw = json.loads(response.read(2_000_000))
            answer = raw.get("choices", [{}])[0].get("message", {}).get("content", "")
            if not isinstance(answer, str) or not answer.strip():
                raise AssistantError("AI_BAD_RESPONSE", "the configured provider returned no analysis", 502)
            return {"task": task, "analysis": answer[:100_000], "model": self.model, "confirmed": False,
                    "notice": "AI output is advisory. Review every cited fact and diff; applying changes and deployment require separate explicit actions."}
        except AssistantError:
            raise
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, json.JSONDecodeError) as exc:
            raise AssistantError("AI_PROVIDER_ERROR", f"AI provider request failed: {type(exc).__name__}", 502) from exc
