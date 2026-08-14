import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { tools } from './tools.js'

const server = new McpServer({
  name: 'computeruse',
  version: '0.1.0',
})

for (const tool of tools) {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (args) => {
    try {
      return await tool.handler(args)
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
    }
  })
}

const transport = new StdioServerTransport()
await server.connect(transport)
