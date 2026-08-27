/**
 * 命令执行桥：Command.execute 走主进程 child_process。
 * 当前使用面仅为 git.ts 的 Command.create(...).execute()。
 */
export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

interface ShellExecuteOptions {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** 超时毫秒（默认 120s） */
  timeoutMs?: number;
}

export class Command {
  static create(program: string, args: string[] = [], options: CommandOptions = {}): Command {
    return new Command(program, args, options);
  }

  private constructor(
    private readonly program: string,
    private readonly args: string[],
    private readonly options: CommandOptions,
  ) {}

  async execute(): Promise<CommandOutput> {
    const opts: ShellExecuteOptions = {
      program: this.program,
      args: this.args,
      cwd: this.options.cwd,
      env: this.options.env,
    };
    return window.dataforge.shell(opts) as Promise<CommandOutput>;
  }

  async spawn(): Promise<never> {
    throw new Error('[Electron] Command.spawn 尚未移植');
  }
}
