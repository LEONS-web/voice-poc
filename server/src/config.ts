export const env = {
  port: Number(process.env.PORT ?? 8787),
  mockAi: process.env.MOCK_AI === '1',
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
    systemPrompt:
      process.env.LLM_SYSTEM_PROMPT ??
      '你是一个友好的语音陪聊助手，请用简短、口语化的一两句话回答用户。',
  },
  stt: {
    baseUrl: process.env.WHISPER_BASE_URL ?? 'https://api.groq.com/openai/v1',
    apiKey: process.env.WHISPER_API_KEY ?? '',
    model: process.env.WHISPER_MODEL ?? 'whisper-large-v3',
  },
  tts: {
    apiKey: process.env.ELEVENLABS_API_KEY ?? '',
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM',
    modelId: process.env.ELEVENLABS_MODEL_ID ?? 'eleven_multilingual_v2',
  },
} as const;

/** 启动时打印（不泄露密钥本身，只报告是否已配置） */
export function describeConfig() {
  return {
    mockAi: env.mockAi,
    llm: env.mockAi
      ? 'mock'
      : `${env.llm.baseUrl} (${env.llm.model}) key=${env.llm.apiKey ? 'set' : 'MISSING'}`,
    stt: env.mockAi
      ? 'mock'
      : `${env.stt.baseUrl} (${env.stt.model}) key=${env.stt.apiKey ? 'set' : 'MISSING'}`,
    tts: env.tts.apiKey
      ? `elevenlabs voice=${env.tts.voiceId}`
      : 'disabled (no ELEVENLABS_API_KEY)',
  };
}
