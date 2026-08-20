'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://127.0.0.1:8787/ws/voice';
const RECORD_SECONDS = 3;

type LogLine = { time: string; text: string; kind?: 'err' | 'ok' };

export default function Home() {
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed'>('closed');
  const [echoInput, setEchoInput] = useState('你好，这是一条 WebSocket 测试消息');
  const [echoResult, setEchoResult] = useState('');
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [stage, setStage] = useState('');
  const [logs, setLogs] = useState<LogLine[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const audioFormatRef = useRef('mp3');
  const echoExpectRef = useRef('');

  const log = useCallback((text: string, kind?: 'err' | 'ok') => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLogs((prev) => [{ time, text, kind }, ...prev].slice(0, 100));
  }, []);

  // ---------- WebSocket 连接 ----------
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsState('open');
      log(`已连接 ${WS_URL}`, 'ok');
    };
    ws.onclose = () => {
      setWsState('closed');
      log('连接已断开', 'err');
    };
    ws.onerror = () => log('WebSocket 出错（确认后端 8787 端口已启动）', 'err');

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          // 非 JSON 文本 = 任务 A 的 echo 原样回包
          if (ev.data === echoExpectRef.current) {
            setEchoResult(ev.data);
            log('[Echo] 服务端原样返回，内容一致', 'ok');
          } else {
            log(`收到未知文本消息：${ev.data}`);
          }
          return;
        }
        switch (msg.type) {
          case 'transcript':
            setTranscript(msg.text);
            log(`[STT] 转写结果：${msg.text}`, 'ok');
            break;
          case 'reply':
            setReply(msg.text);
            log(`[LLM] 回复：${msg.text}`, 'ok');
            break;
          case 'stage':
            setStage(msg.stage);
            log(`阶段：${msg.stage}`);
            break;
          case 'audio_start':
            audioFormatRef.current = msg.format ?? 'mp3';
            audioChunksRef.current = [];
            log(`[TTS] 开始接收流式音频（${msg.format}）`);
            break;
          case 'audio_end':
            finishAudio();
            log('[TTS] 音频接收完成', 'ok');
            break;
          case 'audio_skipped':
            log(`[TTS] 跳过：${msg.reason}`);
            break;
          case 'done':
            setBusy(false);
            setStage('');
            log('管线执行完成', 'ok');
            break;
          case 'pong':
            log('收到 pong', 'ok');
            break;
          case 'error':
            log(`服务端错误：${msg.message}`, 'err');
            setBusy(false);
            setStage('');
            break;
        }
      } else {
        // 二进制帧 = TTS 音频块
        audioChunksRef.current.push(ev.data);
      }
    };

    return () => ws.close();
  }, [log]);

  const finishAudio = () => {
    const mime = audioFormatRef.current === 'wav' ? 'audio/wav' : 'audio/mpeg';
    const blob = new Blob(audioChunksRef.current, { type: mime });
    setAudioUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(blob);
    });
  };

  // ---------- 任务 A：Echo ----------
  const sendEcho = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    echoExpectRef.current = echoInput;
    ws.send(echoInput);
    log(`[Echo] 已发送：${echoInput}`);
  };

  // ---------- 任务 B：录音 3 秒 → STT → LLM（→ TTS） ----------
  const startVoice = async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || busy) return;
    setBusy(true);
    setTranscript('');
    setReply('');
    setAudioUrl('');
    setStage('recording');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current = recorder;
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

      recorder.start();
      setRecording(true);
      log(`开始录音（${RECORD_SECONDS} 秒，格式 ${mime || '默认'}）`);

      setTimeout(() => {
        recorder.stop();
        setRecording(false);
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: mime || 'audio/webm' });
          log(`录音完成，大小 ${blob.size} 字节，发送到后端`);
          ws.send(JSON.stringify({ type: 'audio', mime: mime || 'audio/webm' }));
          blob.arrayBuffer().then((buf) => ws.send(buf));
        };
      }, RECORD_SECONDS * 1000);
    } catch (err) {
      log(`录音失败：${err instanceof Error ? err.message : String(err)}（请检查麦克风权限）`, 'err');
      setBusy(false);
      setStage('');
    }
  };

  const stageLabel: Record<string, string> = {
    recording: '正在录音…',
    stt: 'Whisper 转写中…',
    llm: 'LLM 生成回复中…',
    tts: 'ElevenLabs 合成语音中…',
  };

  return (
    <main>
      <h1>语音 AI 链路 PoC</h1>
      <p className="subtitle">
        Next.js 14 · Fastify · WebSocket · Whisper STT · LLM · ElevenLabs 流式 TTS
      </p>

      <div className="card">
        <h2>
          连接状态
          <span className={`pill ${wsState === 'open' ? 'ok' : ''}`}>
            {wsState === 'open' ? '已连接' : wsState === 'connecting' ? '连接中' : '未连接'}
          </span>
        </h2>
        <p className="status">服务端地址：{WS_URL}（可用环境变量 NEXT_PUBLIC_WS_URL 覆盖）</p>
      </div>

      <div className="card">
        <h2>任务 A · WebSocket Echo<span className="tag">验证 WebSocket</span></h2>
        <div className="row">
          <input
            type="text"
            value={echoInput}
            onChange={(e) => setEchoInput(e.target.value)}
            placeholder="输入一段文本"
          />
          <button onClick={sendEcho} disabled={wsState !== 'open'}>发送并回显</button>
        </div>
        {echoResult && (
          <div className="result">
            <span className="label">服务端原样返回</span>
            {echoResult}
          </div>
        )}
      </div>

      <div className="card">
        <h2>任务 B / C · 语音对话<span className="tag">录音 3 秒 → Whisper → LLM → TTS</span></h2>
        <div className="row">
          <button onClick={startVoice} disabled={wsState !== 'open' || busy}>
            {recording ? '录音中…' : busy ? '处理中…' : `开始录音（${RECORD_SECONDS} 秒）`}
          </button>
          {stage && <span className={`pill ${recording ? 'rec' : ''}`}>{stageLabel[stage] ?? stage}</span>}
        </div>
        {transcript && (
          <div className="result">
            <span className="label">Whisper 转写</span>
            {transcript}
          </div>
        )}
        {reply && (
          <div className="result">
            <span className="label">LLM 回复</span>
            {reply}
          </div>
        )}
        {audioUrl && <audio controls autoPlay src={audioUrl} />}
      </div>

      <div className="card">
        <h2>运行日志</h2>
        <div className="log">
          {logs.map((l, i) => (
            <div key={i} className={l.kind}>
              <span className="t">{l.time}</span>
              {l.text}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
