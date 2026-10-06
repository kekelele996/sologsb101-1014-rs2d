/**
 * 潮位监测站与露滩时段（Tide）
 * 潮位监测站按站点维护「每天的露滩时段」，与外业验收队各记各的；
 * 排期前按 地块 + 日期 对账：测次的作业起止时刻必须落进当天某段露滩时段才算数。
 */

/** 潮位带：低 / 中 / 高（与 Plot.tideZone 对应，仅用于站点归类） */
export type TideLevel = '低' | '中' | '高';

export const TIDE_LEVEL_OPTIONS: TideLevel[] = ['低', '中', '高'];

/** 时段来源：潮位表导入 / 人工维护 */
export type TideSource = '潮位表导入' | '人工维护';

export const TIDE_SOURCE_OPTIONS: TideSource[] = ['潮位表导入', '人工维护'];

export interface TideStation {
  id: string;
  /** 站点编码（潮位表导入时按编码归并，同一编码视为同一站） */
  code: string;
  /** 站点名 */
  name: string;
  /** 所在潮位带 */
  level: TideLevel;
  /**
   * 潮位表版本号：该站「当天时段」每被改动一次 +1。
   * 测次定级时记录定级所依据的版本（Survey.tideBasisVersion）。
   */
  tideTableVersion: number;
  /** 最近一次潮位表导入 / 维护说明 */
  note: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface TideWindow {
  id: string;
  /** 所属潮位监测站 */
  stationId: string;
  /** 日期 YYYY-MM-DD（同一站同一天可有多段） */
  date: string;
  /** 露滩开始时刻 HH:mm */
  startAt: string;
  /** 露滩结束时刻 HH:mm（允许跨 24:00，如 23:30 → 次日 02:00 由 date 锚定） */
  endAt: string;
  /** 该段时段所属的潮位表版本（跟随 TideStation.tideTableVersion） */
  version: number;
  source: TideSource;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑潮位监测站的表单草稿 */
export interface TideStationDraft {
  code: string;
  name: string;
  level: TideLevel;
  note: string;
}

/** 新建 / 编辑露滩时段的表单草稿 */
export interface TideWindowDraft {
  stationId: string;
  date: string;
  startAt: string;
  endAt: string;
  source: TideSource;
}
