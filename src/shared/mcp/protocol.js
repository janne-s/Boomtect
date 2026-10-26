export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

const ERRORS = Object.freeze({ parse: -32700, request: -32600, method: -32601, params: -32602 });

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createMcpServer({ info, instructions, tools }) {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const methods = {
    initialize: ({ protocolVersion } = {}) => ({
      protocolVersion: PROTOCOL_VERSIONS.includes(protocolVersion) ? protocolVersion : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: info,
      instructions
    }),
    ping: () => ({}),
    'tools/list': () => ({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }),
    'tools/call': async ({ name, arguments: args = {}, _meta } = {}, send) => {
      const tool = byName.get(name);
      if (!tool) throw new RpcError(ERRORS.params, `There is no tool ${name}.`);
      const token = _meta?.progressToken;
      const progress = token === undefined ? () => {} : (amount, message) => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: amount, message } });
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await tool.call(args, { progress }), null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
    }
  };

  return async function handle(line, send) {
    let message;
    try { message = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: ERRORS.parse, message: 'The message is not JSON.' } }); }
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
      if (message && 'id' in message && !('result' in message || 'error' in message)) send({ jsonrpc: '2.0', id: message.id, error: { code: ERRORS.request, message: 'The request has no method.' } });
      return;
    }
    if (!('id' in message)) return;
    const method = methods[message.method];
    try {
      if (!method) throw new RpcError(ERRORS.method, `There is no method ${message.method}.`);
      send({ jsonrpc: '2.0', id: message.id, result: await method(message.params, send) });
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } });
    }
  };
}
