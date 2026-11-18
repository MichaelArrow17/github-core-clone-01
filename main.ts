// main.ts — boot the forge and talk to the make.fun coordinator.
//
// Lifecycle: read MAKEFUN_ENV_URL, start the app on a kernel-chosen port,
// register that port with the coordinator, then keep serving until the
// coordinator answers {"done": true}, and exit cleanly.

import { createApp } from './app.ts';

// How long one coordinator request may run before we give up on it.
const REQUEST_BUDGET_MS = 30_000;
// First pause between retries; doubles after every failed attempt.
const FIRST_PAUSE_MS = 250;
// Retries never wait longer than this between attempts.
const MAX_PAUSE_MS = 2_000;

function fail(message: string): never {
  process.stderr.write(`main: ${message}\n`);
  process.exit(1);
}

function coordinatorRoot(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const trimmed = raw.replace(/\/+$/, '');
  if (trimmed === '') fail('MAKEFUN_ENV_URL is not set');
  return trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function longerPause(current: number): number {
  return Math.min(current * 2, MAX_PAUSE_MS);
}

function callCoordinator(url: string, init: RequestInit): Promise<Response> {
  const guard = new AbortController();
  const timer = setTimeout(() => guard.abort(), REQUEST_BUDGET_MS);
  return fetch(url, { ...init, signal: guard.signal }).finally(() => {
    clearTimeout(timer);
  });
}

async function announce(root: string, port: number): Promise<void> {
  let pause = FIRST_PAUSE_MS;
  for (;;) {
    let answer: Response;
    try {
      answer = await callCoordinator(`${root}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch {
      await sleep(pause);
      pause = longerPause(pause);
      continue;
    }
    if (answer.status === 200 || answer.status === 409) {
      console.log(`main: registered on port ${port}`);
      return;
    }
    if (answer.status === 400 || answer.status === 405) {
      fail(`coordinator refused registration (HTTP ${answer.status})`);
    }
    await sleep(pause);
    pause = longerPause(pause);
  }
}

async function waitForDone(root: string): Promise<void> {
  let pause = FIRST_PAUSE_MS;
  for (;;) {
    try {
      const answer = await callCoordinator(`${root}/done`, { method: 'GET' });
      const payload = await answer.json();
      if (payload !== null && typeof payload === 'object' && payload.done === true) {
        console.log('main: coordinator reports done');
        return;
      }
    } catch {
      // A failed or slow poll is just another retry.
    }
    await sleep(pause);
    pause = longerPause(pause);
  }
}

async function run(): Promise<void> {
  const root = coordinatorRoot();
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (typeof bound === 'object' && bound !== null) resolve(bound.port);
      else reject(new Error('could not learn the bound port'));
    });
  });
  console.log(`main: listening on port ${port}`);
  await announce(root, port);
  await waitForDone(root);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  console.log('main: shutting down');
}

run()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const text = err instanceof Error ? err.message : String(err);
    process.stderr.write(`main: ${text}\n`);
    process.exit(1);
  });
