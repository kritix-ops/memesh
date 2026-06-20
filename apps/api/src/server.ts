import { buildApp } from './app.js';
import { env } from './config.js';

const start = async (): Promise<void> => {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info({ port: env.PORT, env: env.NODE_ENV }, '[api boot] server started');
  } catch (err) {
    app.log.fatal({ err }, '[api boot] server failed to start');
    process.exit(1);
  }
};

void start();
