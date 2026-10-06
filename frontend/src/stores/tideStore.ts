/**
 * 潮位侧状态管理（Zustand）
 * 维护潮位监测站、露滩时段与排期/对账页的本地草稿。
 * 关键边界：潮位表导入只开潮位侧事务（见 utils/db.importTideTable），
 * 导入失败只重试潮位侧，外业地块 / 测次 / 排期一律不受影响。
 */
import { create } from 'zustand';
import type { TideStation, TideStationDraft, TideWindow, TideWindowDraft } from '../types/tide';
import {
  ROW_REVISION,
  db,
  importTideTable,
  initDatabase,
  putTideStation,
  removeTideStation,
  replaceStationDayWindows,
  type TideImportFailure,
  type TideImportResult,
  type TideImportRow,
} from '../utils/db';
import { parseTideCsv } from '../utils/tideImport';
import { nowIso, uuid } from '../utils/id';

/** 排期页输入：起止日期 + 选中的地块与各自时长 */
export interface ScheduleRequest {
  stationId: string;
  from: string;
  to: string;
  jobs: Array<{ plotId: string; durationMin: number }>;
}

interface TideStoreState {
  /** 当前在维护的站点 id */
  activeStationId: string;
  /** 当前编辑中的当天时段草稿 */
  windowDraft: TideWindowDraft | null;
  /** 最近一次潮位表导入结果（含逐行失败原因，供只重试潮位侧） */
  lastImport: TideImportResult | null;
  revision: number;
  init: () => Promise<void>;
  setActiveStation: (id: string) => void;
  setWindowDraft: (draft: TideWindowDraft | null) => void;
  createStation: (draft: TideStationDraft) => Promise<TideStation>;
  updateStation: (stationId: string, draft: TideStationDraft) => Promise<void>;
  deleteStation: (stationId: string) => Promise<void>;
  bindPlotStation: (plotId: string, stationId: string) => Promise<void>;
  /** 保存某站某天的全部露滩段（发布新版并让未定级测次失效重算） */
  saveDayWindows: (stationId: string, date: string, windows: Array<Pick<TideWindow, 'startAt' | 'endAt' | 'source'>>) => Promise<number>;
  /** 潮位表导入（只动潮位侧两表） */
  importTable: (rows: TideImportRow[], failures?: TideImportFailure[]) => Promise<TideImportResult>;
  /** 只重试管线里失败的潮位侧行（已解析成功但事务失败） */
  retryImport: () => Promise<TideImportResult | null>;
  /** 重新上传修正后的潮位表，只重试潮位侧（坏行重新解析），外业排期照旧 */
  retryImportText: (text: string) => Promise<TideImportResult>;
}

export const useTideStore = create<TideStoreState>((set, get) => ({
  activeStationId: '',
  windowDraft: null,
  lastImport: null,
  revision: 0,

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  setActiveStation(id) {
    set({ activeStationId: id });
  },

  setWindowDraft(draft) {
    set({ windowDraft: draft });
  },

  async createStation(draft) {
    const stamp = nowIso();
    const code = draft.code.trim() || uuid('tide').slice(-6);
    const row: TideStation = {
      id: `tide-${code}`,
      code,
      name: draft.name.trim() || '未命名潮位站',
      level: draft.level,
      tideTableVersion: 1,
      note: draft.note.trim() || '人工维护',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putTideStation(row);
    set({ revision: get().revision + 1, activeStationId: row.id });
    return row;
  },

  async updateStation(stationId, draft) {
    const existing = await db.tideStations.get(stationId);
    if (!existing) return;
    await putTideStation({
      ...existing,
      code: draft.code.trim() || existing.code,
      name: draft.name.trim() || existing.name,
      level: draft.level,
      note: draft.note.trim() || existing.note,
    });
    set({ revision: get().revision + 1 });
  },

  async deleteStation(stationId) {
    await removeTideStation(stationId);
    if (get().activeStationId === stationId) set({ activeStationId: '' });
    set({ revision: get().revision + 1 });
  },

  async bindPlotStation(plotId, stationId) {
    await db.plots.update(plotId, { tideStationId: stationId, updatedAt: nowIso() });
    set({ revision: get().revision + 1 });
  },

  async saveDayWindows(stationId, date, windows) {
    const version = await replaceStationDayWindows(stationId, date, windows);
    set({ revision: get().revision + 1 });
    return version;
  },

  async importTable(rows, failures = []) {
    const result = await importTideTable(rows, failures);
    set({ revision: get().revision + 1, lastImport: result });
    return result;
  },

  async retryImport() {
    const last = get().lastImport;
    // 只重试潮位侧：失败行重新进潮位事务，与外业排期完全隔离
    if (!last || last.failures.length === 0) return null;
    const retryRows = last.failures
      .filter((item): item is TideImportFailure & { row: TideImportRow } => item.row !== null)
      .map((item) => item.row);
    if (retryRows.length === 0) {
      set({ lastImport: { ...last, failures: [] } });
      return { ...last, failures: [] };
    }
    const result = await importTideTable(retryRows, []);
    set({ revision: get().revision + 1, lastImport: result });
    return result;
  },

  async retryImportText(text) {
    // 用户拿修正后的潮位表文件只重跑潮位侧：重新解析坏行文本，好行进潮位事务，外业一概不动
    const parsed = parseTideCsv(text);
    const result = await importTideTable(parsed.rows, parsed.failures);
    set({ revision: get().revision + 1, lastImport: result });
    return result;
  },
}));
