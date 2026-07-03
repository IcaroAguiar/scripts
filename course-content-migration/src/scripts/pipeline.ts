const passthroughArgs = process.argv.slice(2);

async function runStep(stepName: 'discover' | 'extract' | 'download'): Promise<void> {
  const child = Bun.spawn(['bun', 'run', `src/scripts/${stepName}.ts`, ...passthroughArgs], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
    env: process.env
  });

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${stepName} failed with exit code ${exitCode}`);
  }
}

const startedAt = Date.now();
await runStep('discover');
await runStep('extract');
await runStep('download');
const elapsedMs = Date.now() - startedAt;
console.log(`[PIPELINE] finished successfully in ${(elapsedMs / 1000).toFixed(1)}s`);

