import asyncio
from typing import Dict, Any, List, Optional
import httpx
from cachetools import TTLCache
from config import MCP_ROUTER_URL


class McpRouterClient:
    """
    Lightweight MCP Router HTTP client.

    - Discovers available MCP servers from router
    - Caches list for short TTL
    - Provides simple tool invocation shim (POST /tools/{server_id}/{tool_name}) if router exposes such API later
      For now only discovery is used; tool execution will be done by LLM selection inside processor.
    """
    def __init__(self, base_url: str = MCP_ROUTER_URL, timeout: float = 10.0):
        self.base_url = base_url.rstrip('/')
        self.http = httpx.AsyncClient(timeout=timeout)
        # Cache servers listing for 10 seconds
        self._servers_cache: TTLCache[str, Any] = TTLCache(maxsize=1, ttl=10)

    async def list_servers(self) -> List[Dict[str, Any]]:
        """
        GET /v0/servers
        Returns list of MCP servers with status and meta.
        Docs: https://mcp-router.net/docs/api/list-mcp-servers
        """
        if 'servers' in self._servers_cache:
            return self._servers_cache['servers']
        url = f"{self.base_url}/v0/servers"
        try:
            resp = await self.http.get(url)
            resp.raise_for_status()
            data = resp.json()
            servers = data if isinstance(data, list) else data.get('servers', [])
            self._servers_cache['servers'] = servers
            return servers
        except Exception:
            # Router not reachable or returned error → degrade gracefully
            self._servers_cache['servers'] = []
            return []

    async def get_server_by_name(self, name_or_id: str) -> Optional[Dict[str, Any]]:
        servers = await self.list_servers()
        for s in servers:
            if s.get('identifier') == name_or_id or s.get('name') == name_or_id:
                return s
        return None

    async def aclose(self):
        await self.http.aclose()


class McpToolCatalog:
    """
    A simple registry that maps discovered servers to tool specs usable by LLM prompts.
    In absence of a router-side tool list endpoint, we treat each server as a capability tag.
    """
    def __init__(self, router: McpRouterClient):
        self.router = router

    async def get_capabilities(self) -> Dict[str, Dict[str, Any]]:
        servers = await self.router.list_servers()
        # Represent each server as a tool family with name/description
        tools: Dict[str, Dict[str, Any]] = {}
        for s in servers:
            sid = s.get('identifier') or s.get('name')
            tools[sid] = {
                'title': s.get('name', sid),
                'description': s.get('description', ''),
                'status': s.get('status', 'unknown'),
                'version': s.get('version', ''),
            }
        return tools


