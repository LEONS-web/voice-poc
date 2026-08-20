import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { registerVoiceWs } from './ws.js';
import { describeConfig, env } from './config.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket, {
  options: { maxPayload: 10 * 1024 * 1024 }, // 录音二进制帧上限 10MB，足够 3 秒音频
});

await registerVoiceWs(app);

app.get('/health', async () => ({ status: 'ok', ts: Date.now() }));

app.listen({ port: env.port, host: '0.0.0.0' })
  .then(() => {
    app.log.info({ config: describeConfig() }, 'voice-poc server ready');
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
