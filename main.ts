// Entry point: the forge's lifecycle against the trial environment.
//
// The environment owns the trial. This process only has to do three things,
// in order, and then stay alive until told to stop:
//   1. start the HTTP server on a kernel-chosen (ephemeral) port,
//   2. tell the environment that port, so its suite can dial the forge,
//   3. keep polling the environment until it reports the trial is done,
//      then shut the server down and exit successfully.
//
// Nothing here touches the forge's data. All request handling lives in
// app.ts; this file is only the handshake with the harness.

import { createApp } from './app.ts';

// The environment's base URL, e.g. http://store:8080 inside a trial pod.
// Without it there is no suite to register with, so bail out immediately.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!envOrigin) {
  process.stderr.write('MAKEFUN_ENV_URL is unset; cannot register with the trial env\n');
  process.exit(1);
}

// One HTTP call to the env, with a hard ceiling so a hung env cannot wedge us.
const CALL_BUDGET_MS = 30_000;

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// Backoff between retries: start short, double each time, never past 2s.
// Deterministic enough for a lifecycle loop; no request ever observes it.
function backoffMs(failures: number): number {
  return Math.min(2000, 250 * 2 ** Math.min(failures, 3));
}

// Tell the env which port the forge listens on. 200 means accepted; 409 means
// some other process already claimed the slot, which is also a settled answer.
// Anything else (env still booting, transient network hiccup) is retried
// forever — the trial cannot start until this succeeds.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register rejected with HTTP ${reply.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected')) throw err;
    }
    failures += 1;
    await wait(backoffMs(failures));
  }
}

// Poll GET /done until the env answers {"done": true}. The env replies at
// once with {"done": false} while the suite is still running, so this is a
// plain poll loop, never a held-open request. Any failure just means "not
// done yet" and is retried with backoff.
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(CALL_BUDGET_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
      failures = 0;
    } catch {
      failures += 1;
    }
    await wait(backoffMs(failures));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  process.stdout.write(`forge listening on ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('registered with the trial env; waiting for done\n');

  await waitUntilDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('trial done; exiting\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
