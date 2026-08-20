// WebSocket 冒烟测试（任务 A 自动化验证）
// 用法：先启动服务端（npm --prefix server run dev），再运行 npm --prefix server run smoke
import WebSocket from 'ws';

const url = process.env.WS_URL ?? 'ws://127.0.0.1:8787/ws/voice';
const payload = `echo-冒烟测试-${Date.now()}`;

const timer = setTimeout(() => {
  console.error('FAIL: 5 秒内未收到回包');
  process.exit(1);
}, 5000);

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('✓ 连接成功:', url);
  ws.send(payload);
  console.log('✓ 已发送文本:', payload);
});

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const text = data.toString();
  if (text === payload) {
    console.log('✓ 服务端原样返回，内容一致');
    clearTimeout(timer);
    ws.close();
    console.log('PASS: 任务 A WebSocket Echo 验证通过');
    process.exit(0);
  }
  console.log('收到其他消息:', text);
});

ws.on('error', (err) => {
  console.error('FAIL: 连接错误 -', err.message);
  process.exit(1);
});
