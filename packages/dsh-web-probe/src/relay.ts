import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// R0-only loopback harness; production uses private transport channels.
import { DshWebTransport } from '../../dsh-web/src/transport.ts';
import type { WebTransportInput } from '../../dsh-web/src/transport.ts';
export type ProbeInput = WebTransportInput;
export class NativeWebProbe extends DshWebTransport {
  async exec(program: string): Promise<string> {
    const {stdout}=await promisify(execFile)('docker',['--context','desktop-linux','exec',this.name,'node','-e',program],{timeout:15000,maxBuffer:8192});return stdout.trim();
  }
  constructor(input: ProbeInput) { super({ ...input, publishLoopback: true, transportLabel: 'r0' }); }
}
