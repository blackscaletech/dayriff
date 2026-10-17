import { createApp } from './app.js';
import { loadConfig } from './config.js';

try {
  const config = loadConfig();
  const app = await createApp(config, process.argv.includes('--dev'));
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ mode: config.mode }, 'Dayriff is ready');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Dayriff could not start.');
  process.exitCode = 1;
}
