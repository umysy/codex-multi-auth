'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const TEST_KEY = crypto.createHash('sha256').update('codex-multi-auth-test-only').digest();
function testProtect(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', TEST_KEY, iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return { version: 1, protection: 'test-aes-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: body.toString('base64') };
}
function testUnprotect(envelope) {
  const d = crypto.createDecipheriv('aes-256-gcm', TEST_KEY, Buffer.from(envelope.iv, 'base64'));
  d.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(envelope.ciphertext, 'base64')), d.final()]).toString('utf8');
}

// DPAPI binds ciphertext to the Windows user. Secrets travel through stdin, never command arguments.
function transform(text, decrypt) {
  if (process.platform !== 'win32') throw Object.assign(new Error('Windows DPAPI is required'), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  const method = decrypt ? 'Unprotect' : 'Protect';
  const read = decrypt ? '[Convert]::FromBase64String($s)' : '[Text.Encoding]::UTF8.GetBytes($s)';
  const output = decrypt ? '[Text.Encoding]::UTF8.GetString($b)' : '[Convert]::ToBase64String($b)';
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Security.Cryptography.ProtectedData]::" + method + '(' + read + ', $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write(' + output + ')';
  return execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { input: text, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }).replace(/^\uFEFF/, '');
}
function protect(text) { return { version: 1, protection: 'dpapi-current-user', ciphertext: transform(String(text), false) }; }
function unprotect(envelope) {
  if (process.env.CMA_TEST_MODE === '1' && envelope?.protection === 'test-aes-gcm') return testUnprotect(envelope);
  if (!envelope || envelope.version !== 1 || envelope.protection !== 'dpapi-current-user') throw new Error('Unsupported protected data');
  return transform(envelope.ciphertext, true);
}
function safeProtect(text) { return process.env.CMA_TEST_MODE === '1' ? testProtect(text) : protect(text); }
module.exports = { protect: safeProtect, unprotect };
