// API 密钥验证脚本：读取 server/.env，实测 LLM 与 STT 接口连通性
import 'dotenv/config';
import OpenAI from 'openai';

const key = process.env.LLM_API_KEY;
const baseUrl = process.env.LLM_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';

console.log('测试地址:', baseUrl);
console.log('密钥格式:', key ? key.slice(0, 8) + '...' : '(未设置)');

const client = new OpenAI({ baseURL: baseUrl, apiKey: key });

// 1) LLM 测试
try {
  const r = await client.chat.completions.create({
    model: process.env.LLM_MODEL ?? 'qwen-plus',
    messages: [{ role: 'user', content: '你好' }],
    max_tokens: 20,
  });
  console.log('PASS LLM:', r.choices[0].message.content);
} catch (e) {
  console.error('FAIL LLM:', e.status ?? '', e.message?.slice(0, 300));
}

// 2) STT 测试（qwen-asr）：生成一段 1 秒静音 WAV，仅验证鉴权与接口连通
try {
  const sampleRate = 16000;
  const n = sampleRate;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  const dataUri = `data:audio/wav;base64,${wav.toString('base64')}`;
  const res = await client.chat.completions.create({
    model: process.env.WHISPER_MODEL ?? 'qwen3-asr-flash',
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] }],
    asr_options: { language: 'zh', enable_itn: true },
  });
  console.log('PASS STT: 接口连通，识别结果 =', JSON.stringify(res.choices[0]?.message?.content));
} catch (e) {
  console.error('FAIL STT:', e.status ?? '', e.message?.slice(0, 300));
}
