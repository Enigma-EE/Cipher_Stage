import asyncio
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from langchain_openai import ChatOpenAI
from config import OPENROUTER_API_KEY, OPENROUTER_URL, SUMMARY_MODEL
from .mcp_client import McpRouterClient, McpToolCatalog
from .computer_use import ComputerUseAdapter


@dataclass
class Task:
    id: str
    title: str
    original_query: str
    server_id: Optional[str] = None
    steps: List[str] = field(default_factory=list)
    status: str = "queued"  # queued | running | done | failed
    meta: Dict[str, Any] = field(default_factory=dict)


class TaskPlanner:
    """
    Planner module: preloads server capabilities, judges executability, decomposes task into executable queries.
    """
    def __init__(self, computer_use: Optional[ComputerUseAdapter] = None):
        self.llm = ChatOpenAI(model=SUMMARY_MODEL, base_url=OPENROUTER_URL, api_key=OPENROUTER_API_KEY, temperature=0)
        self.router = McpRouterClient()
        self.catalog = McpToolCatalog(self.router)
        self.task_pool: Dict[str, Task] = {}
        self.computer_use = computer_use or ComputerUseAdapter()

    async def refresh_capabilities(self) -> Dict[str, Dict[str, Any]]:
        try:
            return await self.catalog.get_capabilities()
        except Exception:
            return {}

    async def assess_and_plan(self, task_id: str, query: str, register: bool = True) -> Task:
        # Phase 1: MCP-only decision
        capabilities = await self.refresh_capabilities()
        tools_brief = "\n".join([f"- {k}: {v['description']} (status={v['status']})" for k, v in capabilities.items()])
        mcp_system = (
            "You are a planning agent. Decide ONLY based on MCP server capabilities whether the task is executable."
            " Do NOT consider GUI or computer-use in this step."
            " Output strict JSON: {can_execute: bool, reason: string, server_id: string|null, steps: string[]}"
            " steps should be granular tool queries for the MCP processor."
        )
        mcp_user = f"Capabilities:\n{tools_brief}\n\nTask: {query}"
        resp1 = self.llm.invoke([
            {"role": "system", "content": mcp_system},
            {"role": "user", "content": mcp_user},
        ])
        text1 = resp1.content.strip()
        import json, uuid
        try:
            if text1.startswith("```"):
                text1 = text1.replace("```json", "").replace("```", "").strip()
            mcp = json.loads(text1)
        except Exception:
            mcp = {"can_execute": False, "reason": "LLM parse error", "server_id": None, "steps": []}

        cu_decision = None
        cu = self.computer_use.is_available()

        # Phase 2: Only if MCP cannot execute, evaluate ComputerUse
        if not mcp.get('can_execute'):
            if cu.get('ready'):
                cu_system = (
                    "You are deciding whether a GUI computer-use agent that can control mouse/keyboard, open/close"
                    " apps, browse the web, and interact with typical Windows UI can accomplish the task."
                    " Ignore any MCP tools; ONLY decide feasibility of GUI agent. Output strict JSON:"
                    " {use_computer: bool, reason: string}"
                )
                cu_user = f"Task: {query}"
                resp2 = self.llm.invoke([
                    {"role": "system", "content": cu_system},
                    {"role": "user", "content": cu_user},
                ])
                text2 = resp2.content.strip()
                try:
                    if text2.startswith("```"):
                        text2 = text2.replace("```json", "").replace("```", "").strip()
                    cu_decision = json.loads(text2)
                except Exception:
                    cu_decision = {"use_computer": False, "reason": "LLM parse error"}

                # Do not execute here to avoid blocking; scheduling is handled by server
                # if cu_decision.get('use_computer'): execution will be scheduled by the caller
            else:
                cu_decision = {"use_computer": False, "reason": "ComputerUse not ready"}

        # Determine status without executing blocking GUI operations here
        status = "queued"
        if mcp.get('can_execute'):
            status = "queued"
        else:
            if cu_decision and cu_decision.get('use_computer'):
                status = "queued"
            else:
                status = "failed"

        t = Task(
            id=task_id or str(uuid.uuid4()),
            title=query[:50],
            original_query=query,
            server_id=mcp.get('server_id'),
            steps=mcp.get('steps', []),
            status=status,
            meta={
                "mcp": mcp,
                "computer_use_decision": cu_decision
            },
        )
        if register:
            self.task_pool[t.id] = t
        return t


