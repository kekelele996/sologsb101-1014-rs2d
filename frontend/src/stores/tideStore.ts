/**
 * 潮汐露滩状态管理（Zustand）
 * 维护潮位站、露滩时段、导入批次与对账来源；
 * 测次保存后按地块关联站 + 日期对账；时段改动后没定级测次失效重算、
 * 已定级测次留原值并标依据哪一版；一段排不下顺到下一段；挂起期间不生成补植计划。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { Survey } from '../types/survey';
import type {
  TideImport,
  TideSource,
  TideStation,
  TideStationDraft,
  TideWindow,
  TideWindowDraft,
} from '../types/tide';
import {
  db,
  initDatabase,
  listTideImports,
  listTideSources,
  listTideStations,
  listTideWindows,
  putSurvey,
  putTideImport,
  putTideSource,
  putTideStation,
  putTideWindow,
  removeTideSource,
  removeTideStation,
  removeTideWindow,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import { findNextWindow, isGraded, reconcileSurvey as reconcileSurveyPure } from '../utils/tide';

interface TideStoreState {
  stations: TideStation[];
  windows: TideWindow[];
  imports: TideImport[];
  sources: TideSource[];
  loading: boolean;
  ready: boolean;
  error: string;
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  /** 订阅潮位站 / 时段 / 导入 / 来源并载入（幂等） */
  loadAll: () => Promise<void>;
  createStation: (draft: TideStationDraft) => Promise<TideStation>;
  updateStation: (id: string, draft: TideStationDraft) => Promise<void>;
  deleteStation: (id: string) => Promise<void>;
  saveWindow: (draft: TideWindowDraft, id?: string) => Promise<{ saved: TideWindow; changed: boolean }>;
  deleteWindow: (id: string) => Promise<void>;
  /** 保存测次后对账：返回核对后的测次 */
  reconcileSurvey: (survey: Survey) => Promise<Survey>;
  /** 顺排：把挂起测次排到下一个露滩时段 */
  scheduleNextWindow: (surveyId: string) => Promise<Survey | null>;
  /** 挂起测次复核通过 → 正常 */
  reviewSuspended: (surveyId: string) => Promise<void>;
  /** 潮位表导入（模拟解析，失败只落潮位侧，外业排期照旧） */
  importTideTable: (fileName: string, rows: TideWindowDraft[]) => Promise<TideImport>;
  /** 失败后只重试潮位侧 */
  retryImport: (importId: string) => Promise<void>;
  /** 某地块是否有挂起测次（挂起期间不生成补植计划） */
  hasSuspendedSurvey: (plotId: string) => boolean;
  /** 取某测次的对账来源 */
  sourceOf: (surveyId: string) => TideSource | undefined;
}

let subscribed = false;

export const useTideStore = create<TideStoreState>((set, get) => ({
  stations: [],
  windows: [],
  imports: [],
  sources: [],
  loading: true,
  ready: false,
  error: '',
  revision: 0,
  lastMessage: '',

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  async loadAll() {
    set({ loading: true, error: '' });
    try {
      await initDatabase();
      if (!subscribed) {
        subscribed = true;
        liveQuery(async () => {
          const [stations, windows, imports, sources] = await Promise.all([
            listTideStations(),
            listTideWindows(),
            listTideImports(),
            listTideSources(),
          ]);
          return { stations, windows, imports, sources };
        }).subscribe({
          next: ({ stations, windows, imports, sources }) => {
            set({ stations, windows, imports, sources, loading: false, ready: true, error: '' });
          },
          error: (err: unknown) => {
            set({ loading: false, error: err instanceof Error ? err.message : '读取潮汐数据失败' });
          },
        });
      }
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '初始化潮汐数据库失败' });
    }
  },

  async createStation(draft) {
    const stamp = nowIso();
    const row: TideStation = {
      id: uuid('tide-station'),
      name: draft.name.trim() || '未命名潮位站',
      code: draft.code.trim(),
      location: draft.location.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putTideStation(row);
    set({ revision: get().revision + 1, lastMessage: `潮位站「${row.name}」已建立` });
    return row;
  },

  async updateStation(id, draft) {
    const existing = await db.tideStations.get(id);
    if (!existing) return;
    await putTideStation({
      ...existing,
      name: draft.name.trim() || existing.name,
      code: draft.code.trim(),
      location: draft.location.trim(),
    });
    set({ revision: get().revision + 1 });
  },

  async deleteStation(id) {
    await removeTideStation(id);
    set({ revision: get().revision + 1 });
  },

  async saveWindow(draft, id) {
    const stamp = nowIso();
    const existing = id ? await db.tideWindows.get(id) : undefined;
    const row: TideWindow = existing
      ? { ...existing, ...draft, date: draft.date, startTime: draft.startTime, endTime: draft.endTime }
      : {
          id: uuid('tide-window'),
          stationId: draft.stationId,
          date: draft.date,
          startTime: draft.startTime,
          endTime: draft.endTime,
          version: 1,
          sourceId: 'manual',
          createdAt: stamp,
          updatedAt: stamp,
          revision: 3,
        };
    const { saved, changed } = await putTideWindow(row);
    if (changed) {
      // 时段改动：没定级测次失效重算，已定级测次留原值并标依据哪一版
      await revalidateSurveysForWindow(saved, get);
    }
    set({
      revision: get().revision + 1,
      lastMessage: changed
        ? `露滩时段已更新为 v${saved.version}，未复核测次已重算`
        : '露滩时段已保存',
    });
    return { saved, changed };
  },

  async deleteWindow(id) {
    await removeTideWindow(id);
    set({ revision: get().revision + 1 });
  },

  async reconcileSurvey(survey) {
    const plot = await db.plots.get(survey.plotId);
    const stationId = plot?.tideStationId ?? '';
    const result = reconcileSurveyPure(survey, stationId, get().windows);
    const stamp = nowIso();
    let sourceId = survey.tideSourceId;
    if (result.status === 'normal' && result.window) {
      // 落进时段：新建 / 更新对账来源，钉住当前依据版本
      sourceId = sourceId || uuid('tidesrc');
      const source: TideSource = {
        id: sourceId,
        surveyId: survey.id,
        plotId: survey.plotId,
        stationId: result.window.stationId,
        windowId: result.window.id,
        windowVersionId: result.windowVersionId,
        date: survey.date,
        sourceType: 'manual',
        createdAt: stamp,
      };
      await putTideSource(source);
    } else if (sourceId) {
      // 挂起 / 只读：清掉旧来源，避免依据错版本
      await removeTideSource(sourceId);
      sourceId = '';
    }
    const next: Survey = {
      ...survey,
      tideStatus: result.status,
      tideWindowVersionId: result.windowVersionId,
      tideSourceId: sourceId,
      tideCheckedAt: stamp,
    };
    await putSurvey(next);
    set({ revision: get().revision + 1, lastMessage: result.message });
    return next;
  },

  async scheduleNextWindow(surveyId) {
    const survey = await db.surveys.get(surveyId);
    if (!survey) return null;
    const plot = await db.plots.get(survey.plotId);
    const stationId = plot?.tideStationId ?? '';
    const nextWin = stationId ? findNextWindow(get().windows, stationId, survey.date) : undefined;
    if (!nextWin) {
      set({ lastMessage: '暂无后续露滩时段可顺排，请先在潮位站维护时段' });
      return null;
    }
    // 顺到下一段：改日期，作业时刻保持，重新对账
    const moved: Survey = { ...survey, date: nextWin.date };
    const reconciled = await get().reconcileSurvey(moved);
    set({ lastMessage: `已顺排到下一段：${nextWin.date}（${nextWin.startTime}–${nextWin.endTime}）` });
    return reconciled;
  },

  async reviewSuspended(surveyId) {
    const survey = await db.surveys.get(surveyId);
    if (!survey) return;
    const stamp = nowIso();
    await putSurvey({ ...survey, tideStatus: 'normal', tideCheckedAt: stamp });
    set({ revision: get().revision + 1, lastMessage: '挂起测次已复核通过，转为正常' });
  },

  async importTideTable(fileName, rows) {
    const stamp = nowIso();
    // 模拟解析：行数为 0 视为导入失败（只落潮位侧，外业排期照旧）
    const failed = rows.length === 0;
    const record: TideImport = {
      id: uuid('tide-import'),
      fileName,
      status: failed ? 'failed' : 'success',
      rowCount: rows.length,
      error: failed ? '未解析到有效露滩时段行，请检查潮位表格式后重试' : '',
      importedAt: stamp,
      retriedAt: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    if (!failed) {
      // 按站点 + 日期去重落库
      for (const draft of rows) {
        const win: TideWindow = {
          id: uuid('tide-window'),
          stationId: draft.stationId,
          date: draft.date,
          startTime: draft.startTime,
          endTime: draft.endTime,
          version: 1,
          sourceId: record.id,
          createdAt: stamp,
          updatedAt: stamp,
          revision: 3,
        };
        await putTideWindow(win);
      }
    }
    await putTideImport(record);
    set({
      revision: get().revision + 1,
      lastMessage: failed ? '潮位表导入失败，可在导入批次中只重试潮位侧' : `潮位表导入成功：${rows.length} 条时段`,
    });
    return record;
  },

  async retryImport(importId) {
    const existing = await db.tideImports.get(importId);
    if (!existing) return;
    // 只重试潮位侧：重新置为成功（模拟重试通过），外业排期不受影响、照旧进行
    const stamp = nowIso();
    await putTideImport({ ...existing, status: 'success', error: '', retriedAt: stamp });
    set({ revision: get().revision + 1, lastMessage: '潮位侧重试成功，外业排期未受影响' });
  },

  hasSuspendedSurvey(plotId) {
    // 只读不算挂起；挂起期间不生成补植计划。直接查 DB 保证判断的是最新状态。
    // 这里用同步快照不可靠，改为在 generateReplant 中 await 一个异步判断；
    // 此方法保留为同步读缓存：sources 不含 surveys，故始终返回 false，
    // 真正的拦截在 surveyStore.generateReplant 里通过 db.surveys 完成。
    void plotId;
    return false;
  },

  sourceOf(surveyId) {
    return get().sources.find((s) => s.surveyId === surveyId);
  },
}));

/**
 * 异步判断某地块是否存在挂起测次（只读测次不拦截）。
 * 供 surveyStore.generateReplant 在生成补植计划前调用。
 */
export async function plotHasSuspendedSurvey(plotId: string): Promise<boolean> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.some((row) => row.tideStatus === 'suspended');
}

/**
 * 时段改动后重算该站当天测次：
 * - 已定级（gradeManual）：留原值，把依据版本钉在旧版（不重算）
 * - 没定级：失效，按新时段重新对账
 */
async function revalidateSurveysForWindow(
  win: TideWindow,
  get: () => TideStoreState,
): Promise<void> {
  const plots = await db.plots.where('tideStationId').equals(win.stationId).toArray();
  const plotIds = new Set(plots.map((p) => p.id));
  const surveys = await db.surveys.where('date').equals(win.date).toArray();
  const stamp = nowIso();
  for (const survey of surveys) {
    if (!plotIds.has(survey.plotId)) continue;
    if (isGraded(survey)) {
      // 已定级：留原值，标依据哪一版（钉在改动前的版本）
      const source = get().sources.find((s) => s.surveyId === survey.id);
      await putSurvey({
        ...survey,
        tideWindowVersionId: source?.windowVersionId ?? survey.tideWindowVersionId,
        tideCheckedAt: stamp,
      });
    } else {
      // 没定级：失效重算
      const result = reconcileSurveyPure(survey, win.stationId, get().windows);
      await putSurvey({
        ...survey,
        tideStatus: result.status,
        tideWindowVersionId: result.windowVersionId,
        tideCheckedAt: stamp,
      });
    }
  }
}
