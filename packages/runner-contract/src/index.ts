export interface AgentTurn {
  conversationId: string;
  turnId: string;
  text: string;
}

export interface AgentResult {
  text: string;
  outputs?: { name: string; mime: string; bytes: Buffer }[];
  artifact?: { name: string; text: string };
}

export interface AgentAdapter {
  readonly mode: 'mock' | 'dsh';
  send(turn: AgentTurn): Promise<AgentResult>;
}

export class MockAgentAdapter implements AgentAdapter {
  readonly mode = 'mock';

  async send(turn: AgentTurn): Promise<AgentResult> {
    const text = 'Mock Agent 已收到消息：' + turn.text;
    return { text, artifact: { name: 'mock-output.txt', text } };
  }
}
