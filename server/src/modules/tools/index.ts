/**
 * Tools 進入點：import 時副作用註冊所有工具，並對外提供 registry 與工具建構工具。
 * 上層一律從 '@/modules/tools' import，確保工具在被 invoke 前已完成註冊。
 */
import './oa.tools';
import './email.tools';
import '@/modules/mcp/register';

export {
  isWriteTool,
  registerTool,
  registerToolSource,
  toolRegistry,
  unregisterToolSource,
} from './tool.registry';
export { makeToolContext } from './tool.context';
export type { ToolContext, ToolDef, ToolEffect, ToolSource } from './tool.types';
