import { spawn, ChildProcess } from 'node:child_process';

/**
 * Demo launcher: starts Provider A, Provider B, and Warden in ONE terminal with
 * clean, color-tagged logs interleaved. Run this in one pane, then drive it from
 * another with `npm run buyer -- <mode>`.
 *
 *   npm run agents        # starts all three services
 *   (Ctrl+C stops them all)
 *
 * Each service has its own API key, so this respects the one-WS-per-key rule.
 */
const SERVICES: { name: string; file: string }[] = [
  { name: 'Provider A', file: 'src/demo-providers/providerA.ts' },
  { name: 'Provider B', file: 'src/demo-providers/providerB.ts' },
  { name: 'Warden', file: 'src/warden/index.ts' },
];

const children: ChildProcess[] = [];

console.log('Starting Warden demo services (Provider A, Provider B, Warden)...');
console.log('Drive with:  npm run buyer -- code   (or: good | bad | codebad)\n');

for (const svc of SERVICES) {
  const child = spawn('npx', ['tsx', svc.file], { stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`[launcher] ${svc.name} exited (code ${code}). Shutting down the rest.`);
    shutdown();
  });
  children.push(child);
}

function shutdown() {
  for (const c of children) {
    if (!c.killed) c.kill('SIGINT');
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => {
  console.log('\n[launcher] stopping all services...');
  shutdown();
});
