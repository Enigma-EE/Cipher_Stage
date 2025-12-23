from typing import Dict, Any, List
from langchain_openai import ChatOpenAI
from config import OPENROUTER_API_KEY, OPENROUTER_URL, SUMMARY_MODEL
import httpx
from types import SimpleNamespace


class ConversationAnalyzer:
    """
    Analyzer module: analyze ongoing voice conversation turns to infer potential task intents.
    Input is textual transcript snippets from cross-server; output is zero or more normalized task queries.
    """
    def __init__(self):
        self._is_ollama = OPENROUTER_URL.startswith("http://") and "11434" in OPENROUTER_URL
        if not self._is_ollama:
            self.llm = ChatOpenAI(model=SUMMARY_MODEL, base_url=OPENROUTER_URL, api_key=OPENROUTER_API_KEY, temperature=0)
        else:
            self.llm = None

    def _build_prompt(self, messages: List[Dict[str, str]]) -> str:
        lines = []
        for m in messages[-20:]:
            role = m.get('role', 'user')
            text = m.get('text', '')
            lines.append(f"{role}: {text}")
        conversation = "\n".join(lines)
        return (
            "You analyze conversation snippets and extract potential actionable task queries from the user."
            " Return JSON: {reason: string, tasks: string[]}."
            " Only include tasks that can be delegated to tools; avoid chit-chat."
            f"\nConversation:\n{conversation}"
        )

    def analyze(self, messages: List[Dict[str, str]]):
        prompt = self._build_prompt(messages)
        if not self._is_ollama:
            resp = self.llm.invoke([
                {"role": "system", "content": "You are a precise task intent extractor."},
                {"role": "user", "content": prompt},
            ])
            text = resp.content.strip()
        else:
            merged = "System:\nYou are a precise task intent extractor.\nUser:\n" + prompt
            try:
                with httpx.Client(timeout=httpx.Timeout(20.0)) as client:
                    r = client.post(f"{OPENROUTER_URL}/api/generate", json={
                        "model": SUMMARY_MODEL,
                        "prompt": merged,
                        "stream": False
                    })
                    data = r.json()
                    text = (data.get("response") or "").strip()
            except Exception as e:
                text = f"{{\"tasks\":[],\"reason\":\"ollama_error:{e}\"}}"
        import json
        try:
            if text.startswith("```"):
                text = text.replace("```json", "").replace("```", "").strip()
            data = json.loads(text)
        except Exception as e:
            print(f"Analyzer parse error: {e}")
            data = {"tasks": [], "reason": "parse error", "raw": text}
        return data



