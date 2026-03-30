import type { ResolvedEnv, Capabilities } from '../env.js';
import type { ToolDefinition, ToolResult } from './types.js';
import { zodToInputSchema } from './types.js';

import { webSearchTool } from './web-search.js';
import { redditSearchTool } from './reddit-search.js';
import { redditPostTool } from './reddit-post.js';
import { scrapeTool } from './scrape.js';
import { deepResearchTool } from './deep-research.js';
import { newsTool } from './news.js';
import { hackernewsTool } from './hackernews.js';
import { xSearchTool } from './x-search.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL_TOOLS: ToolDefinition<any>[] = [
  webSearchTool,
  redditSearchTool,
  redditPostTool,
  scrapeTool,
  deepResearchTool,
  newsTool,
  hackernewsTool,
  xSearchTool,
];

const toolMap = new Map(ALL_TOOLS.map(t => [t.name, t]));

export function getAllTools(capabilities: Capabilities) {
  return ALL_TOOLS
    .filter(tool => !tool.capability || capabilities[tool.capability])
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToInputSchema(tool.inputSchema),
    }));
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  capabilities: Capabilities,
  env: ResolvedEnv
): Promise<ToolResult> {
  const tool = toolMap.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  if (tool.capability && !capabilities[tool.capability]) {
    return { content: [{ type: 'text', text: `Tool "${name}" requires ${tool.capability} capability. Set the required API key.` }], isError: true };
  }
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.message}` }], isError: true };
  }
  return tool.handler(parsed.data, env);
}
