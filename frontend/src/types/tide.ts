/**
 * 潮汐露滩（Tide）领域模型
 * 红树林地块需等退潮露滩才能下滩验收：
 * - 潮位监测站按站点发布每天的露滩时段（TideWindow），改动后版本号 +1；
 * - 外业验收队按地块排测次，测次带作业起止时刻，落进当天露滩时段才算数；
 * - 两边各记各的，排期前按地块 + 日期对账（TideSource 即对账依据）。
 */

/** 露滩核对状态：正常 / 挂起（时段外，等复核）/ 只读（历史数据补不上来源） */
export type TideCheckStatus = 'normal' | 'suspended' | 'readonly';

export const TIDE_CHECK_STATUS_LABEL: Record<TideCheckStatus, string> = {
  normal: '正常',
  suspended: '挂起',
  readonly: '只读',
};

export const TIDE_CHECK_STATUS_COLOR: Record<TideCheckStatus, string> = {
  normal: 'green',
  suspended: 'orange',
  readonly: 'default',
};

/** 潮位表导入状态：成功 / 失败（失败后只重试潮位侧，外业排期照旧） */
export type TideImportStatus = 'success' | 'failed';

export const TIDE_IMPORT_STATUS_LABEL: Record<TideImportStatus, string> = {
  success: '成功',
  failed: '失败',
};

/** 潮位监测站 */
export interface TideStation {
  id: string;
  /** 站名，如「东港潮位站」 */
  name: string;
  /** 站点编码 */
  code: string;
  /** 站址描述 */
  location: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 某站点某天的露滩时段 */
export interface TideWindow {
  id: string;
  /** 所属潮位站 */
  stationId: string;
  /** 露滩日期 YYYY-MM-DD */
  date: string;
  /** 露滩开始时刻 HH:mm */
  startTime: string;
  /** 露滩结束时刻 HH:mm */
  endTime: string;
  /** 时段版本号：站点每改动一次当天时段，版本 +1 */
  version: number;
  /** 来源：导入批次 id 或 manual */
  sourceId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 潮位表导入批次（潮位侧独立重试，不影响外业排期） */
export interface TideImport {
  id: string;
  /** 导入文件名 */
  fileName: string;
  /** 导入状态 */
  status: TideImportStatus;
  /** 导入行数 */
  rowCount: number;
  /** 失败原因 */
  error: string;
  /** 导入时间 */
  importedAt: string;
  /** 最近一次重试时间 */
  retriedAt: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/**
 * 来源记录：测次与潮位时段的对账依据。
 * 升级时按测次日期补一条来源，补不上的测次只读留着。
 */
export interface TideSource {
  id: string;
  /** 关联的验收测次 */
  surveyId: string;
  /** 所属地块（冗余，便于按地块对账） */
  plotId: string;
  /** 对账时使用的潮位站 */
  stationId: string;
  /** 对账时命中的露滩时段 */
  windowId: string;
  /** 对账时依据的时段版本（标依据哪一版） */
  windowVersionId: number;
  /** 对账日期 YYYY-MM-DD */
  date: string;
  /** 来源类型：升级补录 / 手工对账 / 导入对账 */
  sourceType: 'backfill' | 'manual' | 'import';
  createdAt: string;
}

/** 新建 / 编辑潮位站的表单草稿 */
export interface TideStationDraft {
  name: string;
  code: string;
  location: string;
}

/** 新建 / 编辑露滩时段的表单草稿 */
export interface TideWindowDraft {
  stationId: string;
  date: string;
  startTime: string;
  endTime: string;
}
