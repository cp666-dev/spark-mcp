#!/usr/bin/env node
// The Spark MCP server: the shared tools, for any agent, over MCP on stdio. Nothing may go to stdout
// except the protocol.
console.log = console.error;

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectEngine } from './engine.mjs';
import { recordPicks } from './taste.mjs';

const { TOOLS, INSTRUCTIONS, present } = globalThis.SparkTools;

const server = new Server({ name: 'spark-mcp', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

let engine = null;
async function connected() {
  if (!engine) engine = await connectEngine();
  await engine.followPicks(recordPicks).catch(() => {});
  return engine;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.schema,
    annotations: { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `There is no tool named ${params.name}.` }] };
  try {
    const { result, spectrogram } = present(await tool.run(await connected(), params.arguments ?? {}));
    const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    if (spectrogram) content.push({ type: 'image', data: spectrogram, mimeType: 'image/png' });
    return { content };
  } catch (error) {
    const missing = error?.code === 'not_running';
    if (missing) engine = null;
    return { isError: true, content: [{ type: 'text', text: missing ? 'LUNA is not running, or has no session open.' : error.message }] };
  }
});

await server.connect(new StdioServerTransport());

// The connection to LUNA would keep this process alive after its agent has gone.
process.stdin.on('close', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
