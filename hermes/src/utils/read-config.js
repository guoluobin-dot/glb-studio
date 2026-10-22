/**
 * 读 config/default.json 的统一入口（抗 BOM）。
 *
 * 2026-10-10 加。
 *
 * 为什么需要：JSON.parse 遇到 UTF-8 BOM 会直接抛
 * "Unexpected token ﻿"（一个不可见的 U+FEFF）。
 * 而 BOM 在 Windows 上极其常见 ——
 *   - 记事本「另存为 UTF-8」会带 BOM
 *   - PowerShell 的 Set-Content -Encoding UTF8 也会带 BOM
 * 用户在「引擎」面板填完 key 之后顺手用记事本改一下配置是很自然的事，
 * 结果就是：配置读不出来 → 服务起不来 / 热重载失败 → 面板永远显示云端不可用，
 * 而真正的原因（BOM）既不在界面上也不在日志里。
 *
 * 顺带把失败信息说人话：文件不存在 / 不是合法 JSON 时，
 * 直接把文件名和 JSON.parse 的位置带出来，而不是抛一个裸的 SyntaxError。
 */
import { readFileSync } from 'fs';

/** 去掉 UTF-8 BOM（U+FEFF）。JS 源文件本身也可能是带 BOM 的，所以这里做防御。 */
export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

export function readJsonFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`读不到文件 ${path}：${err.message}`);
  }
  const hadBom = raw.charCodeAt(0) === 0xFEFF;
  try {
    return JSON.parse(stripBom(raw));
  } catch (err) {
    throw new Error(
      `${path} 不是合法 JSON：${err.message}`
      + (hadBom ? '（文件开头有 UTF-8 BOM —— 记事本/PowerShell 另存为 UTF-8 时会带，删掉首字符或改存 UTF-8 无 BOM 即可）' : '')
    );
  }
}