import { pathToFileURL } from 'node:url';
const load = name => import(pathToFileURL(`${process.cwd()}/dist/${name}.js`).href);
const { prisma } = await load('db');
const { assertProductionAuthSafe } = await load('services/authConfig');
const { assertIdentityOutboxConfigured } = await load('services/identityOutbox');
const { startScheduler, drainScheduler, scheduledJobsForThisProcess } = await load('services/scheduler');
assertProductionAuthSafe();
assertIdentityOutboxConfigured();
if (process.env.SCHEDULER_ENABLED !== 'true' || process.env.SERVICE_PROFILE !== 'all') {
  throw new Error('Dedicated scheduler needs explicit activation and all profile');
}
startScheduler();
console.log(JSON.stringify({ service: 'junshi-scheduler', event: 'started', jobs: scheduledJobsForThisProcess().map(j => j.name) }));
const keepalive = setInterval(() => {}, 3600000);
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ service: 'junshi-scheduler', event: 'draining' }));
  try {
    await drainScheduler();
    await prisma.$disconnect();
    clearInterval(keepalive);
    console.log(JSON.stringify({ service: 'junshi-scheduler', event: 'drained' }));
    process.exit(code);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
process.on('SIGTERM', () => { void stop(0); });
process.on('SIGINT', () => { void stop(0); });
process.on('uncaughtException', error => { console.error(error); void stop(1); });
process.on('unhandledRejection', error => { console.error(error); void stop(1); });
