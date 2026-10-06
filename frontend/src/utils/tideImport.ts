/**
 * 潮位表 CSV 解析（纯本地）
 * 潮位表导入失败后只重试潮位侧：逐行解析，坏行进 failures（带行号与原因），
 * 不抛整批错误，好行照常导入，坏行可在页面上「重试潮位侧」。
 *
 * CSV 列（含表头）：站点编码, 站点名称, 潮位带, 日期, 露滩开始, 露滩结束
 * 示例：DG-01,东港南堤潮位站,中,2025-03-15,07:00,10:00
 */
import type { TideImportFailure, TideImportRow } from './db';
import { isValidHm } from './tide';
import { TIDE_LEVEL_OPTIONS, type TideLevel } from '../types/tide';

export interface ParsedTideCsv {
  rows: TideImportRow[];
  failures: TideImportFailure[];
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result.map((cell) => cell.trim());
}

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

function isLevel(value: string): value is TideLevel {
  return (TIDE_LEVEL_OPTIONS as string[]).includes(value);
}

/** 解析潮位表 CSV 文本 */
export function parseTideCsv(text: string): ParsedTideCsv {
  const clean = text.replace(/^﻿/, '');
  const lines = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const rows: TideImportRow[] = [];
  const failures: TideImportFailure[] = [];

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    // 跳过表头
    if (lineNo === 1 && /站点编码|编码/.test(line) && !/^\d{4}-/.test(line)) return;
    const cells = splitCsvLine(line);
    if (cells.length < 6) {
      failures.push({ row: null, line: lineNo, reason: `列数不足（需 6 列），实际 ${cells.length} 列` });
      return;
    }
    const [code, stationName, level, date, startAt, endAt] = cells;
    if (code === '') {
      failures.push({ row: null, line: lineNo, reason: '缺少站点编码' });
      return;
    }
    if (!isLevel(level)) {
      failures.push({ row: null, line: lineNo, reason: `潮位带非法：${level || '（空）'}，应为 低/中/高` });
      return;
    }
    if (!isValidDate(date)) {
      failures.push({ row: null, line: lineNo, reason: `日期格式非法：${date || '（空）'}，应为 YYYY-MM-DD` });
      return;
    }
    if (!isValidHm(startAt) || !isValidHm(endAt)) {
      failures.push({ row: null, line: lineNo, reason: `时刻格式非法：${startAt || '（空）'} ~ ${endAt || '（空）'}，应为 HH:mm` });
      return;
    }
    rows.push({ code, stationName: stationName || code, level, date, startAt, endAt });
  });

  return { rows, failures };
}
