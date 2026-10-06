/**
 * 成活率验收（Survey）
 * 按测次登记成活株数与平均株高，成活率由成活株数 / 栽植总株数派生。
 *
 * 潮位对账口径：
 * - 红树林地块得等退潮露滩才能下滩验收；测次除日期外还带「作业起止时刻」。
 * - 作业起止落进所属潮位站当天某段露滩时段才算「露滩有效」；
 *   涨潮硬凑（作业落在露滩时段外）的测次照收，但标记为「涨潮硬凑」。
 * - 落在时段外、尚未确认的先挂起等复核；挂起期间不生成补植计划。
 * - 已有数据没有作业时刻，升级时按测次日期补一条「时刻来源」；补不上的只读留着。
 */

/** 成活率等级：优 / 良 / 一般 / 差 */
export type RateLevel = 'excellent' | 'good' | 'fair' | 'poor';

export const RATE_LEVEL_LABEL: Record<RateLevel, string> = {
  excellent: '优',
  good: '良',
  fair: '一般',
  poor: '差',
};

export const RATE_LEVEL_OPTIONS: RateLevel[] = ['excellent', 'good', 'fair', 'poor'];

/**
 * 潮位对账状态：
 * - exposed    露滩有效：作业起止落在当天露滩时段内
 * - forced     涨潮硬凑：作业落在露滩时段外但照常验收（照收，仍可定级参与统计）
 * - suspended  挂起待复核：作业在时段外、尚未确认
 * - invalidated 已失效：潮位站改动当天时段后，未定级测次对不上新时段，需重算
 * - legacyValid  历史有效：老数据升级后按测次日期补上时刻来源
 * - legacyReadonly 历史只读：老数据升级后补不上时刻来源，只读留着
 */
export type TideStatus =
  | 'exposed'
  | 'forced'
  | 'suspended'
  | 'invalidated'
  | 'legacyValid'
  | 'legacyReadonly';

export const TIDE_STATUS_LABEL: Record<TideStatus, string> = {
  exposed: '露滩有效',
  forced: '涨潮硬凑',
  suspended: '挂起待复核',
  invalidated: '已失效重算',
  legacyValid: '历史有效',
  legacyReadonly: '历史只读',
};

/** 作业时刻来源：升级时给没有时刻的历史测次补一条 */
export type TimeSource = '现场记录' | '历史日期补录' | '无法补录';

export const TIME_SOURCE_LABEL: Record<TimeSource, string> = {
  现场记录: '现场记录',
  历史日期补录: '历史日期补录',
  无法补录: '无法补录',
};

export interface Survey {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 测次（1、2、3……） */
  round: number;
  /** 验收日期 YYYY-MM-DD */
  date: string;
  /** 作业开始时刻 HH:mm（历史数据升级时可能为空字符串） */
  startAt: string;
  /** 作业结束时刻 HH:mm */
  endAt: string;
  /** 作业时刻来源 */
  timeSource: TimeSource;
  /** 潮位对账状态 */
  tideStatus: TideStatus;
  /** 定级依据的潮位表版本（人工定级或露滩有效时锁定），无依据时为 0 */
  tideBasisVersion: number;
  /** 成活株数 */
  aliveCount: number;
  /** 平均株高（厘米） */
  avgHeightCm: number;
  /** 成活率（百分比，保留 1 位小数）——默认由成活株数 / 栽植总株数派生 */
  survivalRate: number;
  /** 成活率等级——默认按区间自动判定，可人工批量调整 */
  grade: RateLevel;
  /** 该等级是否被人工调整过（定级后锁定，不随后续潮位时段改动而变） */
  gradeManual: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑验收记录的表单草稿 */
export interface SurveyDraft {
  plotId: string;
  round: number;
  date: string;
  startAt: string;
  endAt: string;
  /** 涨潮硬凑：作业落在露滩时段外但照常验收照收 */
  forced: boolean;
  aliveCount: number;
  avgHeightCm: number;
}
