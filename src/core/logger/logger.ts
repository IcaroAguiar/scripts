import fs from 'fs-extra';
import path from 'node:path';

export type LogScope = 'DISCOVER' | 'DOWNLOAD' | 'FAILED' | 'SKIPPED' | 'RETRY' | 'LOGIN' | 'DRIVE';

export class Logger {
  constructor(private readonly logsDir: string) {}

  async log(scope: LogScope, message: string, meta?: Record<string, unknown>): Promise<void> {
    await fs.ensureDir(this.logsDir);
    const line = `[${scope}] ${new Date().toISOString()} ${message}${
      meta ? ` ${JSON.stringify(meta)}` : ''
    }\n`;
    process.stdout.write(line);
    await fs.appendFile(path.join(this.logsDir, `${new Date().toISOString().slice(0, 10)}.log`), line);
  }
}
