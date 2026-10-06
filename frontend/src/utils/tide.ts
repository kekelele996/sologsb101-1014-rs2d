/**
 * 露滩对账与外业排期的纯函数口径
 * - 时刻比较（HH:mm，支持跨 24:00 的露滩段）
 * - 测次作业起止是否落进当天露滩时段
 * - 潮位对账状态判定（露滩有效 / 涨潮硬凑 / 挂起 / 失效）
 * - 按地块 + 日期把作业排进露滩段，排不下的顺到下一段，仍排不下的挂起
 */
import type { Plot } from '../types/plot';
import type { TideWindow } from '../types/tide';
import type { TideStatus } from '../types/survey';

/** 把 HH:mm 换成当天分钟数 */
export function hmToMin(hm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 是否为合法 HH:mm */
export function isValidHm(hm: string): boolean {
  return Number.isFinite(hmToMin(hm));
}

/**
 * 作业区间 [startAt, endAt] 是否完整落进某段露滩窗口。
 * 露滩窗口按 date 锚定，允许 endAt 早于 startAt 表示跨到次日凌晨（如 23:00→01:30）。
 */
export function fitsWindow(startAt: string, endAt: string, win: Pick<TideWindow, 'startAt' | 'endAt'>): boolean {
  const s = hmToMin(startAt);
  const e = hmToMin(endAt);
  const ws = hmToMin(win.startAt);
  let we = hmToMin(win.endAt);
  if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(ws) || !Number.isFinite(we)) return false;
  if (we <= ws) we += 24 * 60; // 跨午夜
  // 作业同样允许跨午夜：结束不早于开始（否则视为到次日）
  const jobEnd = e < s ? e + 24 * 60 : e;
  return s >= ws && jobEnd <= we;
}

/** 在某天的露滩段里找一段能完整容纳作业区间的窗口 */
export function findFittingWindow(
  startAt: string,
  endAt: string,
  windows: TideWindow[],
): TideWindow | null {
  return windows.find((win) => fitsWindow(startAt, endAt, win)) ?? null;
}

/**
 * 判定一条已录入测次的潮位对账状态。
 * @param hasTimes 该测次是否带作业起止时刻
 * @param forced   作业落在时段外但照常验收（涨潮硬凑照收）
 * @param dayWindows 所属站当天的露滩时段（空数组表示当天无任何时段）
 */
export function evaluateTideStatus(args: {
  hasTimes: boolean;
  forced: boolean;
  legacy: boolean;
  dayWindows: TideWindow[];
  startAt: string;
  endAt: string;
}): TideStatus {
  const { hasTimes, forced, legacy, dayWindows, startAt, endAt } = args;
  if (legacy) {
    return hasTimes ? 'legacyValid' : 'legacyReadonly';
  }
  if (!hasTimes) {
    // 新数据要求带时刻；没有时刻一律挂起等复核
    return 'suspended';
  }
  if (dayWindows.length === 0) {
    // 当天没有任何露滩时段可对账：硬凑照收，否则挂起
    return forced ? 'forced' : 'suspended';
  }
  const fit = findFittingWindow(startAt, endAt, dayWindows) !== null;
  if (fit) return 'exposed';
  // 落进时段外：硬凑照收，否则先挂起等复核
  return forced ? 'forced' : 'suspended';
}

/** 参与成活率 / 补植统计的对账状态（挂起、失效、历史只读不参与） */
export const EFFECTIVE_TIDE_STATUS: TideStatus[] = ['exposed', 'forced', 'legacyValid'];

export function isEffectiveStatus(status: TideStatus): boolean {
  return EFFECTIVE_TIDE_STATUS.includes(status);
}

/** 挂起期间不生成补植计划 */
export function blocksReplant(status: TideStatus): boolean {
  return status === 'suspended' || status === 'invalidated' || status === 'legacyReadonly';
}

/* --------------------------------- 排期 --------------------------------- */

/** 排期兜底：按面积估算单地块单段作业时长（分钟），每 10 亩 30 分钟，限幅 60–240 */
export function estimateDurationMin(areaMu: number): number {
  if (!Number.isFinite(areaMu) || areaMu <= 0) return 90;
  return Math.max(60, Math.min(240, Math.round((areaMu / 10) * 30)));
}

/** 取地块排期用的作业时长：地块自填优先，否则按面积估算 */
export function durationOf(plot: Plot): number {
  return Number.isFinite(plot.surveyDurationMin) && plot.surveyDurationMin > 0
    ? plot.surveyDurationMin
    : estimateDurationMin(plot.areaMu);
}

/** 分钟数 → HH:mm */
export function minToHm(value: number): string {
  const wrapped = ((value % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface ScheduleItem {
  plotId: string;
  /** 排入的露滩段日期；null 表示所有段都排不下，挂起等复核 */
  date: string | null;
  startAt: string;
  endAt: string;
  /** 排入时段的潮位表版本 */
  version: number;
  windowId: string;
  /** 顺移次数：0=当天首段即容纳，>0=前面段排不下顺到了后段 */
  rollover: number;
  suspended: boolean;
}

/**
 * 把一批地块按顺序排进给定的露滩段（同站、按日期升序）。
 * 贪心：一段内顺序装箱，当前段剩余装不下就顺到下一段（顺移 +1）；
 * 全部段都装不下的地块挂起（date=null），挂起期间不生成补植计划。
 */
export function schedulePlots(
  jobs: Array<{ plotId: string; durationMin: number }>,
  windows: TideWindow[],
): ScheduleItem[] {
  const sortedWins = [...windows].sort((a, b) =>
    a.date.localeCompare(b.date) !== 0 ? a.date.localeCompare(b.date) : a.startAt.localeCompare(b.startAt),
  );
  // 每段维护一个「游标」（当天分钟数，跨午夜顺延 24h）
  const cursor = sortedWins.map((win) => {
    const start = hmToMin(win.startAt);
    let end = hmToMin(win.endAt);
    if (end <= start) end += 24 * 60;
    return { winId: win.id, start, end, used: start };
  });

  return jobs.map((job) => {
    let rollover = 0;
    for (let i = 0; i < cursor.length; i += 1) {
      const seg = cursor[i];
      if (seg.used + job.durationMin <= seg.end) {
        const item: ScheduleItem = {
          plotId: job.plotId,
          date: sortedWins[i].date,
          startAt: minToHm(seg.used),
          endAt: minToHm(seg.used + job.durationMin),
          version: sortedWins[i].version,
          windowId: seg.winId,
          rollover,
          suspended: false,
        };
        seg.used += job.durationMin;
        return item;
      }
      rollover += 1; // 当前段排不下，顺到下一段
    }
    return {
      plotId: job.plotId,
      date: null,
      startAt: '',
      endAt: '',
      version: 0,
      windowId: '',
      rollover,
      suspended: true,
    };
  });
}
