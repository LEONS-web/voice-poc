import OpenAI from 'openai';
import { env } from './config.js';

/**
 * 任务 B 第二步：LLM 生成回复
 * 采用 OpenAI 兼容协议，可无缝切换 DeepSeek / OpenAI / Moonshot / 任意兼容服务；
 * 如需 Anthropic 原生协议，仅需替换本模块内部实现，接口不变。
 */
export async function chat(userText: string): Promise<string> {
  if (env.mockAi) {
    return `（模拟回复）我听到了：「${userText}」。当前是模拟模式，配置 LLM 密钥后这里会返回 AI 的真实回答。`;
  }
  const client = new OpenAI({ baseURL: env.llm.baseUrl, apiKey: env.llm.apiKey });
  const res = await withTimeout(
    client.chat.completions.create({
      model: env.llm.model,
      messages: [
        { role: 'system', content: env.llm.systemPrompt },
        { role: 'user', content: userText },
      ],
      max_tokens: 300,
    }),
    15000
  );
  return (res.choices[0]?.message?.content ?? '').trim();
}

/** 给 OpenAI SDK 调用加超时熔断：上游卡死时抛错而非永久阻塞 WebSocket 链路 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM 请求超时（${ms}ms）`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
