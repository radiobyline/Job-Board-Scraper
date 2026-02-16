import { runWeeklyPipeline } from './monitor/weekly.js';

interface CliArgs {
  maxGroups?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max-groups' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.maxGroups = Math.floor(parsed);
      }
      i += 1;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await runWeeklyPipeline({
    maxGroups: args.maxGroups,
  });
}

main().catch((error) => {
  console.error(`Weekly pipeline failed: ${String(error)}`);
  process.exitCode = 1;
});
