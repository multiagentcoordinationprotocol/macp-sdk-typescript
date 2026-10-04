import { Auth, MacpClient, ModeRegistryWatcher } from '../src';

async function main(): Promise<void> {
  const client = new MacpClient({
    address: process.env.MACP_RUNTIME_ADDRESS ?? '127.0.0.1:50051',
    secure: false,
    allowInsecure: true, // local dev only; production must use TLS (RFC-MACP-0006 §3)
    auth: Auth.devAgent('coordinator'),
  });

  await client.initialize();

  const watcher = new ModeRegistryWatcher(client, { auth: Auth.devAgent('coordinator') });

  // Use AbortController to stop after 10 seconds
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10_000);

  console.log('watching mode registry for 10 seconds...');
  try {
    for await (const change of watcher.changes(controller.signal)) {
      console.log('registry changed at', change.observedAtUnixMs);
    }
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'CANCELLED') {
      console.log('watch cancelled');
    } else {
      throw error;
    }
  } finally {
    // A non-CANCELLED throw above must still close the client -- an open
    // watch stream left dangling keeps the process alive indefinitely.
    client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
