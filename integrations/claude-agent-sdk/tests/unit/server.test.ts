import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { macpConsensusServer, type ConsensusResult } from '../../src/index.js';
import { fakeClient, fixed } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

/** Connects an MCP client to the server's in-process instance, as the Agent SDK does. */
async function connect(server: ReturnType<typeof macpConsensusServer>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0' });
  await Promise.all([server.instance.connect(serverSide), mcp.connect(clientSide)]);
  return mcp;
}

describe('macpConsensusServer over MCP', () => {
  it('lists one consensus tool whose schema requires an option, and runs it', async () => {
    const { client } = fakeClient();
    const mcp = await connect(
      macpConsensusServer({
        client,
        participants: [
          { id: 'a', evaluator: fixed('APPROVE') },
          { id: 'b', evaluator: fixed('REJECT') },
          { id: 'c', evaluator: fixed('APPROVE') },
        ],
      }),
    );
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual(['consensus']);
    expect(tools[0]!.inputSchema).toMatchObject({
      type: 'object',
      properties: { option: { type: 'string' }, rationale: { type: 'string' }, details: { type: 'object' } },
      required: ['option'],
    });

    const out = await mcp.callTool({
      name: 'consensus',
      arguments: { option: 'refund order 9', rationale: 'dup charge' },
    });
    expect(out.isError).toBeFalsy();
    const result = out.structuredContent as unknown as ConsensusResult;
    expect(result).toMatchObject({ outcome: 'approve', approvals: 2, threshold: 2 });
    expect(JSON.parse((out.content as { text: string }[])[0]!.text)).toEqual(result);
    await mcp.close();
  });

  it('refuses arguments that do not match the schema before any session opens', async () => {
    const { client, sent } = fakeClient();
    const mcp = await connect(
      macpConsensusServer({ client, participants: [{ id: 'a', evaluator: fixed('APPROVE') }] }),
    );
    const out = await mcp.callTool({ name: 'consensus', arguments: { option: '' } });
    expect(out.isError).toBe(true);
    expect(sent).toEqual([]);
    await mcp.close();
  });
});
