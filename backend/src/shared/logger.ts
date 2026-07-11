/**
 * Tiny structured logger. Every line is timestamped and tagged with the
 * process name so multi-process demo logs stay readable in one terminal.
 * Also satisfies the SDK's `Logger` interface so we can pass it into AgentClient.
 */
export interface Logger {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
}

const COLORS: Record<string, string> = {
  WARDEN: '\x1b[36m', // cyan
  'PROVIDER-A': '\x1b[32m', // green
  'PROVIDER-B': '\x1b[33m', // yellow
  BUYER: '\x1b[35m', // magenta
  SMOKE: '\x1b[34m', // blue
};
const RESET = '\x1b[0m';

export function makeLogger(tag: string): Logger {
  const color = COLORS[tag] ?? '';
  const prefix = () => `${color}[${new Date().toISOString()}] ${tag}${RESET}`;
  return {
    info: (m, ...a) => console.log(`${prefix()} ${m}`, ...a),
    warn: (m, ...a) => console.warn(`${prefix()} WARN ${m}`, ...a),
    error: (m, ...a) => console.error(`${prefix()} ERROR ${m}`, ...a),
    // debug is intentionally quiet unless DEBUG=1 to keep the demo terminal clean
    debug: (m, ...a) =>
      process.env.DEBUG ? console.log(`${prefix()} debug ${m}`, ...a) : undefined,
  };
}
