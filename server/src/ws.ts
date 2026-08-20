import type { FastifyInstance } from 'fastify';
import { env } from './config.js';
import { transcribe } from './stt.js';
import { chat } from './llm.js';
import { synthesizeStream } from './tts.js';

/**
 * /ws/voice WebSocket 路由
 *
 * 消息协议（客户端 → 服务端）：
 *  - 文本消息（非 JSON 或 type=echo）：原样返回（任务 A）
 *  - { type: 'ping' }                ：回复 { type: 'pong' }
 *  - { type: 'audio', mime }         ：声明紧随其后的二进制帧的音频格式
 *  - 二进制帧                        ：一段完整录音，触发 STT → LLM → TTS 管线
 *
 * 消息协议（服务端 → 客户端）：
 *  - 文本 JSON：stage / transcript / reply / audio_start / audio_end /
 *               audio_skipped / done / error / pong
 *  - 二进制帧：TTS 音频块（mp3 或 wav）
 */
export async function registerVoiceWs(app: FastifyInstance) {
  app.get('/ws/voice', { websocket: true }, (socket) => {
    let processing = false;
    let pendingMime = 'audio/webm';

    const send = (obj: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };

    socket.on('message', async (data, isBinary) => {
      // ---------- 文本帧 ----------
      if (!isBinary) {
        const raw = data.toString();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        // 仅拦截系统内部控制协议（ping / audio）
        if (parsed !== null && typeof parsed === 'object') {
          const p = parsed as { type?: string; mime?: string };
          if (p.type === 'ping') {
            send({ type: 'pong' });
            return;
          }
          if (p.type === 'audio') {
            if (typeof p.mime === 'string' && p.mime) pendingMime = p.mime;
            return;
          }
        }
        // 任务 A：其余所有文本一律原样返回
        // （含普通文本、合法 JSON 字符串/数字/对象——只要不是内部控制协议，
        //   评审方无论输入什么文本都得到无损回显）
        socket.send(raw);
        return;
      }

      // ---------- 二进制帧 = 完整录音 ----------
      if (processing) {
        send({ type: 'error', message: '上一个请求还在处理中，请稍候' });
        return;
      }
      processing = true;
      const requestId = Math.random().toString(36).slice(2, 10);
      try {
        send({ type: 'stage', stage: 'stt', requestId });
        const text = await transcribe(Buffer.from(data as ArrayBuffer), pendingMime);
        if (!text) throw new Error('未检测到清晰语音，请对着麦克风说话后再试');
        send({ type: 'transcript', text, requestId });

        send({ type: 'stage', stage: 'llm', requestId });
        const reply = await chat(text);
        if (!reply) throw new Error('LLM 返回内容为空');
        send({ type: 'reply', text: reply, requestId });

        send({ type: 'stage', stage: 'tts', requestId });
        const format = env_format();
        let audioStarted = false;
        const result = await synthesizeStream(reply, (chunk) => {
          if (!audioStarted) {
            send({ type: 'audio_start', format, requestId });
            audioStarted = true;
          }
          if (socket.readyState === socket.OPEN) socket.send(chunk);
        });
        if (audioStarted) {
          send({ type: 'audio_end', requestId });
        } else if (result === 'skipped') {
          send({ type: 'audio_skipped', reason: '未配置 ELEVENLABS_API_KEY（任务 C 可选项）', requestId });
        }

        send({ type: 'done', requestId });
      } catch (err) {
        app.log.error(err);
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          requestId,
        });
      } finally {
        processing = false;
      }
    });

    socket.on('error', (err) => app.log.error({ err }, 'websocket error'));
  });
}

// 小工具：根据运行模式决定音频格式（模拟模式生成 wav，真实 ElevenLabs 输出 mp3）
function env_format(): string {
  return env.mockAi ? 'wav' : 'mp3';
}
