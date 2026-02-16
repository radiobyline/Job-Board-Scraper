import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function nowIso(): string {
  return new Date().toISOString();
}

export class RunLogger {
  constructor(
    private readonly filePath: string,
    private readonly runLabel = 'Discovery run',
  ) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, '', 'utf8');
    await this.write(`=== ${this.runLabel} started ${nowIso()} ===`);
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
    await this.write(`=== ${this.runLabel} finished ${nowIso()} ===`);
  }

  private async write(message: string): Promise<void> {
    await appendFile(this.filePath, `${nowIso()} ${message}\n`, 'utf8');
  }
}
