import { Auth, MacpClient, TaskSession } from '../src';

async function main(): Promise<void> {
  const client = new MacpClient({
    address: '127.0.0.1:50051',
    secure: false,
    allowInsecure: true, // local dev only; production must use TLS (RFC-MACP-0006 §3)
    auth: Auth.devAgent('coordinator'),
  });

  const init = await client.initialize();
  console.log('initialize', init.selectedProtocolVersion, init.runtimeInfo?.name);

  const session = new TaskSession(client);
  await session.start({
    intent: 'build the login page',
    participants: ['worker'],
    ttlMs: 120_000,
  });

  await session.requestTask({
    taskId: 't1',
    title: 'Implement login page',
    instructions: 'Build a login form with email and password fields',
    requestedAssignee: 'worker',
  });

  await session.acceptTask({
    taskId: 't1',
    assignee: 'worker',
    reason: 'on it',
    sender: 'worker',
    auth: Auth.devAgent('worker'),
  });

  await session.updateTask({
    taskId: 't1',
    status: 'working',
    progress: 0.5,
    message: 'form layout complete',
    sender: 'worker',
    auth: Auth.devAgent('worker'),
  });

  console.log('progress', session.projection.progressOf('t1'));

  await session.completeTask({
    taskId: 't1',
    assignee: 'worker',
    summary: 'login page with validation',
    sender: 'worker',
    auth: Auth.devAgent('worker'),
  });

  console.log('complete?', session.projection.isCompleted('t1'));

  await session.commit({
    action: 'task.completed',
    authorityScope: 'team-lead',
    reason: 'task finished successfully',
  });

  const metadata = await session.metadata();
  console.log('state', metadata.metadata.state);
  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
