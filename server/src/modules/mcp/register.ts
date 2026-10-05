/** 副作用：把 MCP 工具來源註冊進 Tool Registry（由 '@/modules/tools' 進入點 import）。 */
import { registerToolSource } from '@/modules/tools/tool.registry';
import { mcpToolSource } from './mcp.tool-source';

registerToolSource(mcpToolSource);
