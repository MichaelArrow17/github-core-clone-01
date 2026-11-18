// main.ts — entrypoint: bind an ephemeral port, register it with the
// environment, serve the forge until the environment reports done, then exit.

import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 2000;

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envUrl === '') {
  console.error('error: MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const registerUrl = `${envUrl}/register`;
const doneUrl = `${envUrl}/done`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextDelay(delay: number): number {
  return Math.min(delay * 2, BACKOFF_MAX_MS);
}

async function postRegister(port: number): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: controller.signal,
    });
    return response.status;
  } finally {
    clearTimeout(timer);
  }
}

async function pollDone(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(doneUrl, { signal: controller.signal });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === 'object' &&
      body !== null &&
      (body as { done?: unknown }).done === true
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(0, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine the listening port'));
        return;
      }
      resolve(address.port);
    });
  });
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { port, close };
}

async function main(): Promise<void> {
  const { port, close } = await listen();
  console.log(`listening on port ${port}`);

  let delay = BACKOFF_START_MS;
  for (;;) {
    let status: number;
    try {
      status = await postRegister(port);
    } catch {
      await sleep(delay);
      delay = nextDelay(delay);
      continue;
    }
    if (status === 200 || status === 409) break;
    if (status === 400 || status === 405) {
      throw new Error(`register rejected with status ${status}`);
    }
    await sleep(delay);
    delay = nextDelay(delay);
  }
  console.log('registered');

  delay = BACKOFF_START_MS;
  for (;;) {
    if (await pollDone()) break;
    await sleep(delay);
    delay = nextDelay(delay);
  }
  console.log('done');

  await close();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
