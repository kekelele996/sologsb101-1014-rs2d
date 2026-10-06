/**
 * 潮汐露滩对账与排期工具（纯函数）
 * - 作业时刻是否落进露滩时段
 * - 按地块 + 日期对账（测次 ↔ 潮位站时段）
 * - 一段排不下顺到下一段（下一个露滩时段）
 * - 时段改动后：没定级的测次失效重算，已定级的留原值并标依据哪一版
 */
import type { Survey } from '../types/survey';
import type { TideCheckStatus, TideWindow } from '../types/tide';

/** HH:mm → 分钟数，便于比较 */
export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 判断时刻 time 是否落在 [start, end] 区间内（含边界） */
export function timeWithinWindow(time: string, start: string, end: string): boolean {
  const t = hhmmToMinutes(time);
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  if (!Number.isFinite(t) || !Number.isFinite(s) || !Number.isFinite(e)) return false;
  return t >= s && t <= e;
}

/** 判断作业起止区间是否整体落在露滩时段内 */
export function workWithinWindow(workStart: string, workEnd: string, win: TideWindow): boolean {
  if (!workStart || !workEnd) return false;
  const ws = hhmmToMinutes(workStart);
  const we = hhmmToMinutes(workEnd);
  if (!Number.isFinite(ws) || !Number.isFinite(we)) return false;
  if (we < ws) return false; // 跨日作业不在本工具处理范围内
  return timeWithinWindow(workStart, win.startTime, win.endTime) && timeWithinWindow(workEnd, win.startTime, win.endTime);
}

/** 在时段列表中查找某站某天的露滩时段 */
export function findWindow(windows: TideWindow[], stationId: string, date: string): TideWindow | undefined {
  return windows.find((w) => w.stationId === stationId && w.date === date);
}

/**
 * 顺排：找该站在指定日期之后（含当天之后）的下一个露滩时段。
 * 一段排不下的地块顺到下一段。
 */
export function findNextWindow(windows: TideWindow[], stationId: string, afterDate: string): TideWindow | undefined {
  return windows
    .filter((w) => w.stationId === stationId && w.date > afterDate)
    .sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)))[0];
}

export interface ReconcileResult {
  /** 对账后的露滩核对状态 */
  status: TideCheckStatus;
  /** 命中的露滩时段（无命中为 undefined） */
  window: TideWindow | undefined;
  /** 依据的时段版本 */
  windowVersionId: number;
  /** 面向用户的说明 */
  message: string;
}

/**
 * 对账：按地块关联的潮位站 + 测次日期，核对作业起止时刻是否落进当天露滩时段。
 * - 落进时段 → normal（算数）
 * - 落进时段外 / 当天无时段 → suspended（挂起等复核）
 */
export function reconcileSurvey(
  survey: Pick<Survey, 'date' | 'workStartTime' | 'workEndTime'>,
  stationId: string,
  windows: TideWindow[],
): ReconcileResult {
  if (!stationId) {
    return { status: 'suspended', window: undefined, windowVersionId: 0, message: '地块未关联潮位监测站，无法对账，先挂起等复核' };
  }
  const win = findWindow(windows, stationId, survey.date);
  if (!win) {
    return { status: 'suspended', window: undefined, windowVersionId: 0, message: '当天无露滩时段，测次先挂起等复核' };
  }
  if (!survey.workStartTime || !survey.workEndTime) {
    return { status: 'suspended', window: win, windowVersionId: win.version, message: '未填作业起止时刻，无法核对是否落进露滩时段，先挂起' };
  }
  if (workWithinWindow(survey.workStartTime, survey.workEndTime, win)) {
    return {
      status: 'normal',
      window: win,
      windowVersionId: win.version,
      message: `作业 ${survey.workStartTime}–${survey.workEndTime} 落进露滩时段 ${win.startTime}–${win.endTime}（v${win.version}）`,
    };
  }
  return {
    status: 'suspended',
    window: win,
    windowVersionId: win.version,
    message: `作业 ${survey.workStartTime}–${survey.workEndTime} 落在露滩时段 ${win.startTime}–${win.endTime} 之外，挂起等复核`,
  };
}

/**
 * 潮位站改动当天时段后，对测次的处理：
 * - 已定级（gradeManual）：留原值，标依据哪一版（不重算）
 * - 没定级：失效重算（按新时段重新对账）
 */
export function isGraded(survey: Pick<Survey, 'gradeManual'>): boolean {
  return survey.gradeManual === true;
}

/** 时段展示文案，如「06:30–09:15」 */
export function windowText(win: TideWindow | undefined): string {
  if (!win) return '无时段';
  return `${win.startTime}–${win.endTime}`;
}
