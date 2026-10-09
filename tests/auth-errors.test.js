import test from 'node:test';
import assert from 'node:assert/strict';
import { messageForAuthError } from '../src/auth-errors.js';

test('network login errors tell the user this is connectivity, not lost local data', () => {
  const message = messageForAuthError({ code: 'auth/network-request-failed' });
  assert.match(message, /连接不到 Firebase 账号服务/);
  assert.match(message, /切换 Wi-Fi\/蜂窝网络/);
  assert.match(message, /本机账本不会丢失/);
});

test('Firebase authorization configuration errors have a targeted remedy', () => {
  assert.match(messageForAuthError({ code: 'auth/unauthorized-domain' }), /授权域名/);
  assert.match(messageForAuthError({ code: 'auth/invalid-api-key' }), /部署配置/);
});
