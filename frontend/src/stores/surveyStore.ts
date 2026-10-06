/**
 * 验收状态管理（Zustand）
 * 维护验收筛选条件、批量选中的记录与成活率等级草稿；
 * 成活率派生值统一由 hooks/useSurvivalRate 的纯函数产出，避免口径分散。
 * 落库前调用 reconcileSurvey 按地块所属潮位站「当天露滩时段」对账，
 * 落进时段才算露滩有效；时段外硬凑照收；未确认的先挂起等复核。
 */
import { create } from 'zustand';
import type { RateLevel, Survey, SurveyDraft, TideStatus } from '../types/survey';
import { db, initDatabase, patchSurveyGrades, putSurvey, reconcileSurvey, removeSurvey } from '../utils/db';
import type { SurvivalSummary } from '../hooks/useSurvivalRate';
import { nowIso, uuid } from '../utils/id';
import { calcSurvivalRate } from '../utils/rate';
import { fitsWindow } from '../utils/tide';
import { usePlotStore } from './plotStore';

/** 验收筛选条件（地块 + 对账状态 + 等级 + 关键字 + 日期区间） */
export interface SurveyFilters {
  plotId: string | 'all';
  tideStatus: TideStatus | 'all';
  level: RateLevel | 'all';
  keyword: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: SurveyFilters = { plotId: 'all', tideStatus: 'all', level: 'all', keyword: '', from: '', to: '' };

interface SurveyStoreState {
  filters: SurveyFilters;
  /** 批量操作选中的验收记录 id */
  selectedIds: string[];
  /** 批量调整使用的目标等级 */
  gradeDraft: RateLevel;
  /** 每次写操作后的版本号，页面据此重新拉取列表 */
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  setFilters: (patch: Partial<SurveyFilters>) => void;
  resetFilters: () => void;
  setSelectedIds: (ids: string[]) => void;
  setGradeDraft: (level: RateLevel) => void;
  createSurvey: (draft: SurveyDraft) => Promise<Survey>;
  updateSurvey: (surveyId: string, draft: SurveyDraft) => Promise<void>;
  deleteSurvey: (surveyId: string) => Promise<void>;
  /** 批量调整成活率等级（人工复核） */
  bulkApplyGrade: (level: RateLevel) => Promise<number>;
  /** 挂起 / 失效测次的人工复核动作：确认硬凑照收 或 确认露滩有效 */
  reviewSurvey: (surveyId: string, decision: 'forced' | 'exposed') => Promise<void>;
  /** 按最新测次生成补植计划（挂起期间不生成） */
  generateReplant: (plotId: string) => Promise<string>;
  summaryOf: (plotId: string | null) => SurvivalSummary;
  rateStats: () => { total: number; warnCount: number; avgRate: number };
}

function totalPlantedOf(plotId: string): number {
  return usePlotStore
    .getState()
    .plantings.filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);
}

export const useSurveyStore = create<SurveyStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  selectedIds: [],
  gradeDraft: 'good',
  revision: 0,
  lastMessage: '',

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS }, selectedIds: [] });
  },

  setSelectedIds(ids) {
    set({ selectedIds: [...ids] });
  },

  setGradeDraft(level) {
    set({ gradeDraft: level });
  },

  async createSurvey(draft) {
    const total = totalPlantedOf(draft.plotId);
    const survivalRate = calcSurvivalRate(draft.aliveCount, total);
    const stamp = nowIso();
    const base: Survey = {
      id: uuid('survey'),
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      startAt: draft.startAt,
      endAt: draft.endAt,
      timeSource: '现场记录',
      tideStatus: 'suspended',
      tideBasisVersion: 0,
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      survivalRate,
      grade: 'good',
      gradeManual: false,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    // 落库前按地块 + 日期与潮位站当天露滩时段对账
    const reconciled = await reconcileSurvey(base, draft.forced);
    await putSurvey(reconciled);
    set({ revision: get().revision + 1 });
    return reconciled;
  },

  async updateSurvey(surveyId, draft) {
    const existing = await db.surveys.get(surveyId);
    if (!existing) return;
    const total = totalPlantedOf(draft.plotId);
    const survivalRate = calcSurvivalRate(draft.aliveCount, total);
    const legacy = existing.tideStatus === 'legacyValid' || existing.tideStatus === 'legacyReadonly';
    const merged: Survey = {
      ...existing,
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      // 历史只读行不允许编辑（页面已禁用）；历史有效行补录的时刻沿用其历史来源，不参与新时段重判
      startAt: legacy ? existing.startAt : draft.startAt,
      endAt: legacy ? existing.endAt : draft.endAt,
      timeSource: legacy ? existing.timeSource : '现场记录',
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      survivalRate,
    };
    // 已人工定级 / 历史行保留原状态与依据版本；其余重新对账
    const reconciled = existing.gradeManual || legacy ? merged : await reconcileSurvey(merged, draft.forced);
    await putSurvey(reconciled);
    set({ revision: get().revision + 1 });
  },

  async deleteSurvey(surveyId) {
    await removeSurvey(surveyId);
    set({ selectedIds: get().selectedIds.filter((id) => id !== surveyId), revision: get().revision + 1 });
  },

  async bulkApplyGrade(level) {
    // 只有对账有效（露滩 / 硬凑 / 历史有效）的测次才能定级；挂起、失效、只读先复核
    const gradeable = get().selectedIds.filter((id) => {
      const row = usePlotStore.getState().surveys.find((item) => item.id === id);
      if (!row) return false;
      return row.tideStatus === 'exposed' || row.tideStatus === 'forced' || row.tideStatus === 'legacyValid';
    });
    if (gradeable.length === 0) return 0;
    // 人工复核只改写等级标注，不改写实测成活率数值，保证数据可追溯；同时锁定依据版本
    await patchSurveyGrades(gradeable, level);
    set({ revision: get().revision + 1, lastMessage: `已批量调整 ${gradeable.length} 条验收记录的成活率等级` });
    return gradeable.length;
  },

  async reviewSurvey(surveyId, decision) {
    const existing = await db.surveys.get(surveyId);
    if (!existing) return;
    const stamp = nowIso();
    const plot = await db.plots.get(existing.plotId);
    const station = plot?.tideStationId ? await db.tideStations.get(plot.tideStationId) : undefined;
    if (decision === 'forced') {
      // 确认涨潮硬凑：照收，标记并锁当前潮位表版本
      await db.surveys.update(surveyId, {
        tideStatus: 'forced',
        tideBasisVersion: station?.tideTableVersion ?? existing.tideBasisVersion,
        updatedAt: stamp,
      });
      set({ revision: get().revision + 1, lastMessage: '已按涨潮硬凑照收该测次' });
    } else {
      // 改时段重核：用现有作业时刻与该站当天新时段重新对账（对得上才解除挂起）
      const dayWindows = plot?.tideStationId
        ? await db.tideWindows.where('[stationId+date]').equals([plot.tideStationId, existing.date]).toArray()
        : [];
      const win =
        existing.startAt !== '' && existing.endAt !== ''
          ? dayWindows.find((item) => fitsWindow(existing.startAt, existing.endAt, item)) ?? null
          : null;
      if (win) {
        await db.surveys.update(surveyId, {
          tideStatus: 'exposed',
          tideBasisVersion: win.version,
          updatedAt: stamp,
        });
        set({ revision: get().revision + 1, lastMessage: '作业时刻对得上新时段，已按露滩有效解除挂起' });
      } else {
        await db.surveys.update(surveyId, {
          tideStatus: 'suspended',
          tideBasisVersion: 0,
          updatedAt: stamp,
        });
        set({ revision: get().revision + 1, lastMessage: '作业时刻仍对不上新时段，维持挂起；请在验收台修正时刻或确认硬凑' });
      }
    }
  },

  async generateReplant(plotId) {
    const summary = get().summaryOf(plotId);
    const plot = usePlotStore.getState().plots.find((row) => row.id === plotId);
    if (!plot) return '地块不存在，无法生成补植计划';
    // 挂起 / 失效 / 只读期间不生成补植计划：最新有效测次缺失时直接拦下
    if (summary.latest === null) {
      return '该地块最新测次仍挂起待复核（或无有效测次），挂起期间不生成补植计划';
    }
    const missing = summary.suggestReplant;
    if (missing <= 0) return '该地块当前无缺株，无需生成补植计划';
    const species = usePlotStore.getState().seedlings.find((row) => row.plotId === plotId)?.species ?? '秋茄';
    const stamp = nowIso();
    await db.replants.put({
      id: uuid('replant'),
      plotId,
      missingCount: missing,
      planDate: new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      species,
      state: '待补植',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    });
    set({ revision: get().revision + 1, lastMessage: `已为「${plot.name}」生成补植计划：缺株 ${missing} 株` });
    return `已生成补植计划：缺株 ${missing} 株`;
  },

  summaryOf(plotId) {
    return usePlotStore.getState().summaryOf(plotId);
  },

  rateStats() {
    const { summaries } = usePlotStore.getState();
    const list = Object.values(summaries);
    const withSurvey = list.filter((item) => item.latest !== null);
    if (withSurvey.length === 0) return { total: 0, warnCount: 0, avgRate: 0 };
    const sum = withSurvey.reduce((acc, item) => acc + item.latestRate, 0);
    return {
      total: withSurvey.length,
      warnCount: withSurvey.filter((item) => item.warn).length,
      avgRate: Math.round((sum / withSurvey.length) * 10) / 10,
    };
  },
}));
