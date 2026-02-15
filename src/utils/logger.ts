import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

function nowIso(): string {
  return new Date().toISOString();
}

export class RunLogger {
  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.write(`=== Discovery run started ${nowIso()} ===`);
  }

  async info(message: string): Promise<void> {
    await this.write(`[INFO] ${message}`);
  }

  async warn(message: string): Promise<void> {
    await this.write(`[WARN] ${message}`);
  }

  async error(message: string): Promise<void> {
    await this.write(`[ERROR] ${message}`);
  }

  async close(): Promise<void> {
    await this.write(`=== Discovery run finished ${nowIso()} ===`);
  }

  private async write(message: string): Promise<void> {
    await appendFile(this.filePath, `${nowIso()} ${message}\n`, 'utf8');
  }
}
