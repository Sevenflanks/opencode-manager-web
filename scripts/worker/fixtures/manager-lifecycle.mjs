// 當次 child 的獨立 lifetime；不依賴 test runner 的 finally 才能退出。
const lifetime = setTimeout(() => process.exit(1), 12_000);
await import('../../../apps/manager/dist/src/server.js');
process.on('message', (message) => {
  // Windows 不提供 POSIX graceful signal；僅模擬送達 Node handler，Linux 使用真 signal。
  if (process.platform === 'win32' && ['SIGTERM', 'SIGINT'].includes(message)) process.emit(message);
});
process.on('disconnect', () => process.emit('SIGTERM'));
process.send?.({ ready: true });
process.on('exit', () => clearTimeout(lifetime));
