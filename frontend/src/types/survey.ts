/**
 * 成活率验收（Survey）
 * 按测次登记成活株数与平均株高，成活率由成活株数 / 栽植总株数派生。
 * 测次带作业起止时刻，落进当天露滩时段才算数；停在时段外先挂起等复核，
 * 挂起期间不生成补植计划。
 */
import type { TideCheckStatus } from './tide';

/** 成活率等级：优 / 良 / 一般 / 差 */
export type RateLevel = 'excellent' | 'good' | 'fair' | 'poor';

export const RATE_LEVEL_LABEL: Record<RateLevel, string> = {
  excellent: '优',
  good: '良',
  fair: '一般',
  poor: '差',
};

export const RATE_LEVEL_OPTIONS: RateLevel[] = ['excellent', 'good', 'fair', 'poor'];

export interface Survey {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 测次（1、2、3……） */
  round: number;
  /** 验收日期 YYYY-MM-DD */
  date: string;
  /** 成活株数 */
  aliveCount: number;
  /** 平均株高（厘米） */
  avgHeightCm: number;
  /** 成活率（百分比，保留 1 位小数）——默认由成活株数 / 栽植总株数派生 */
  survivalRate: number;
  /** 成活率等级——默认按区间自动判定，可人工批量调整 */
  grade: RateLevel;
  /** 该等级是否被人工调整过（已定级：潮位时段改动后留原值并标版本） */
  gradeManual: boolean;
  /** 作业开始时刻 HH:mm（测次带作业起止时刻，落进当天露滩时段才算数） */
  workStartTime: string;
  /** 作业结束时刻 HH:mm */
  workEndTime: string;
  /** 露滩核对状态：正常 / 挂起 / 只读（历史数据补不上来源） */
  tideStatus: TideCheckStatus;
  /** 对账时依据的潮位时段版本（标依据哪一版） */
  tideWindowVersionId: number;
  /** 来源记录 id（升级时按测次日期补一条来源） */
  tideSourceId: string;
  /** 最近一次露滩核对时间 */
  tideCheckedAt: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑验收记录的表单草稿 */
export interface SurveyDraft {
  plotId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
  workStartTime: string;
  workEndTime: string;
}
