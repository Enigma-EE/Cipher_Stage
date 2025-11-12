from typing import Dict, Any, Optional
import asyncio
from langchain_openai import ChatOpenAI
from config import OPENROUTER_API_KEY, OPENROUTER_URL, SUMMARY_MODEL
from .mcp_client import McpRouterClient, McpToolCatalog


class Processor:
    """
    Processor module: accepts a natural language query and routes to appropriate MCP tools via LLM reasoning.
    Minimal implementation uses LLM to choose server capability and return a structured action plan.
    """
    def __init__(self):
        self.llm = ChatOpenAI(model=SUMMARY_MODEL, base_url=OPENROUTER_URL, api_key=OPENROUTER_API_KEY, temperature=0)
        self.router = McpRouterClient()
        self.catalog = McpToolCatalog(self.router)

    async def process(self, query: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        capabilities = await self.catalog.get_capabilities()
        tools_brief = "\n".join([f"- {k}: {v['description']} (status={v['status']})" for k, v in capabilities.items()])
        system = (
            "You are a tool routing agent. Given a user task, select one MCP server capability by id and"
            " produce a concise JSON with fields: reason, server_id, tool_calls (optional list of {query})."
            " If no server fits or status is not online, return can_execute=false with reason."
        )
        user = f"Capabilities:\n{tools_brief}\n\nTask: {query}"
        resp = self.llm.invoke([
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ])
        text = resp.content.strip()
        import json
        try:
            if text.startswith("```"):
                text = text.replace("```json", "").replace("```", "").strip()
            parsed = json.loads(text)
        except Exception:
            parsed = {"can_execute": False, "reason": "LLM parse error", "raw": text}
        return parsed


