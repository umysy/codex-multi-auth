'use strict';
/**
 * 小文件工具：容错读 JSON、原子写、从混合输出里抠 JSON、读文件尾部。
 * 纯 I/O 辅助，不含业务知识。
 */
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}

function readJsonResult(file) {
  try {
    return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) };
  } catch (error) {
    return { exists: fs.existsSync(file), ok: false, value: null, error };
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    // A sharing violation must preserve the old file. Never unlink it as a fallback.
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw error;
  }
}

/** CLI 偶尔在 JSON 前后夹日志行：只取第一个 { 到最后一个 }。 */
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** 只读文件尾部 maxBytes：日志文件可能很大，不能整读。 */
function readTail(file, maxBytes = 24000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

module.exports = { readJson, readJsonResult, writeJson, extractJson, readTail };
