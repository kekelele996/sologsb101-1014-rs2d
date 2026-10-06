/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：潮位站/地块 → 苗木批次 / 栽植 / 露滩时段 → 验收 → 补植
 * 所有 id 固定，保证 /plots/:id/seedlings、/plots/:id/plantings 深链一定命中真实数据。
 */
import { db, ROW_REVISION } from './db';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey, RateLevel, TideStatus, TimeSource } from '../types/survey';
import type { Replant } from '../types/replant';
import type { TideStation, TideWindow } from '../types/tide';
import { calcSurvivalRate, rateLevel } from './rate';

const SEED_TIME = '2025-01-06T02:00:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  plotA: 'plot-donggang-3',
  plotB: 'plot-xiwan-a',
  plotC: 'plot-beiyu-b',
  stationA: 'tide-donggang',
  stationB: 'tide-xiwan',
  stationC: 'tide-beiyu',
} as const;

function plotRow(row: Omit<Plot, 'createdAt' | 'updatedAt' | 'revision'>): Plot {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function seedlingRow(row: Omit<Seedling, 'createdAt' | 'updatedAt' | 'revision'>): Seedling {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function plantingRow(row: Omit<Planting, 'createdAt' | 'updatedAt' | 'revision'>): Planting {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function stationRow(row: Omit<TideStation, 'createdAt' | 'updatedAt' | 'revision'>): TideStation {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function windowRow(row: Omit<TideWindow, 'createdAt' | 'updatedAt' | 'revision'>): TideWindow {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

interface SeedSurveyInput {
  id: string;
  plotId: string;
  round: number;
  date: string;
  startAt: string;
  endAt: string;
  aliveCount: number;
  avgHeightCm: number;
  tideStatus: TideStatus;
  timeSource?: TimeSource;
  /** 人工定级锁定的等级；不传则按成活率自动判定 */
  manualGrade?: RateLevel;
  /** 定级依据的潮位表版本 */
  basisVersion?: number;
}

function surveyRow(input: SeedSurveyInput, total: number): Survey {
  const survivalRate = calcSurvivalRate(input.aliveCount, total);
  const gradeManual = input.manualGrade !== undefined;
  return {
    id: input.id,
    plotId: input.plotId,
    round: input.round,
    date: input.date,
    startAt: input.startAt,
    endAt: input.endAt,
    timeSource: input.timeSource ?? '现场记录',
    tideStatus: input.tideStatus,
    tideBasisVersion: input.basisVersion ?? 0,
    aliveCount: input.aliveCount,
    avgHeightCm: input.avgHeightCm,
    survivalRate,
    grade: input.manualGrade ?? rateLevel(survivalRate),
    gradeManual,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    revision: ROW_REVISION,
  };
}

function replantRow(row: Omit<Replant, 'createdAt' | 'updatedAt' | 'revision'>): Replant {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

/**
 * 播种演示数据。调用方（initDatabase）已保证仅在主表为空时调用，因此天然幂等；
 * 这里再做一次防御：若已存在地块则直接返回。
 */
export async function seedDatabase(): Promise<void> {
  const exists = await db.plots.count();
  if (exists > 0) return;

  // ---------------- 潮位监测站（3 站，覆盖三种潮位带） ----------------
  const stations: TideStation[] = [
    stationRow({ id: SEED_IDS.stationA, code: 'DG-01', name: '东港南堤潮位站', level: '中', tideTableVersion: 1, note: '第 1 版：人工维护' }),
    stationRow({ id: SEED_IDS.stationB, code: 'XW-02', name: '西湾滩涂潮位站', level: '低', tideTableVersion: 1, note: '第 1 版：潮位表导入' }),
    // 北屿站改过一次当天时段，已到第 2 版（用于演示「已定级留原值并标依据版本」）
    stationRow({ id: SEED_IDS.stationC, code: 'BY-03', name: '北屿外滩潮位站', level: '高', tideTableVersion: 2, note: '第 2 版：2024-05-28 当天时段调整' }),
  ];

  // ---------------- 露滩时段（按站 + 日期） ----------------
  const windows: TideWindow[] = [
    windowRow({ id: 'tidewin-a1', stationId: SEED_IDS.stationA, date: '2024-06-20', startAt: '08:00', endAt: '11:30', version: 1, source: '人工维护' }),
    windowRow({ id: 'tidewin-a2', stationId: SEED_IDS.stationA, date: '2024-09-18', startAt: '08:00', endAt: '11:30', version: 1, source: '人工维护' }),
    // 第 3 测次当天露滩在早上，作业排到了下午 -> 挂起待复核
    windowRow({ id: 'tidewin-a3', stationId: SEED_IDS.stationA, date: '2025-03-15', startAt: '07:00', endAt: '10:00', version: 1, source: '人工维护' }),
    windowRow({ id: 'tidewin-b1', stationId: SEED_IDS.stationB, date: '2024-07-05', startAt: '06:00', endAt: '09:00', version: 1, source: '潮位表导入' }),
    // 第 2 测次涨潮硬凑：露滩在清晨，作业在下午，照收
    windowRow({ id: 'tidewin-b2', stationId: SEED_IDS.stationB, date: '2024-10-12', startAt: '05:30', endAt: '08:00', version: 1, source: '潮位表导入' }),
    // 已改版：2024-05-28 当天由 v1 的 05:00-08:00 调成 v2 的 06:00-08:30
    windowRow({ id: 'tidewin-c1-v2', stationId: SEED_IDS.stationC, date: '2024-05-28', startAt: '06:00', endAt: '08:30', version: 2, source: '人工维护' }),
    windowRow({ id: 'tidewin-c2', stationId: SEED_IDS.stationC, date: '2024-08-30', startAt: '08:30', endAt: '12:00', version: 2, source: '人工维护' }),
  ];

  // ---------------- 地块（3 块，各挂一个潮位站） ----------------
  const plots: Plot[] = [
    plotRow({
      id: SEED_IDS.plotA,
      name: '东港南堤 3 号地块',
      areaMu: 46.5,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      tideStationId: SEED_IDS.stationA,
      surveyDurationMin: 120,
      missingCount: 1092,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.plotB,
      name: '西湾滩涂 A 区',
      areaMu: 32,
      tideZone: '低',
      substrate: '砂泥质',
      restoreMode: '补植',
      state: '跟踪中',
      tideStationId: SEED_IDS.stationB,
      surveyDurationMin: 90,
      missingCount: 0,
      lastReplantDate: '2025-04-20',
    }),
    plotRow({
      id: SEED_IDS.plotC,
      name: '北屿外滩 B 区',
      areaMu: 58.2,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '已验收',
      tideStationId: SEED_IDS.stationC,
      surveyDurationMin: 150,
      missingCount: 560,
      lastReplantDate: '2024-11-08',
    }),
  ];

  // ---------------- 苗木批次（每地块 2 批） ----------------
  const seedlings: Seedling[] = [
    seedlingRow({ id: 'seedling-a1', plotId: SEED_IDS.plotA, species: '秋茄', source: '自育苗', spec: '50cm 裸根苗', quantity: 3200, arrivalDate: '2024-04-05' }),
    seedlingRow({ id: 'seedling-a2', plotId: SEED_IDS.plotA, species: '桐花树', source: '外购', spec: '40cm 营养袋苗', quantity: 2400, arrivalDate: '2024-04-10' }),
    seedlingRow({ id: 'seedling-b1', plotId: SEED_IDS.plotB, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 1900, arrivalDate: '2024-04-28' }),
    seedlingRow({ id: 'seedling-b2', plotId: SEED_IDS.plotB, species: '秋茄', source: '外购', spec: '50cm 营养袋苗', quantity: 1600, arrivalDate: '2024-05-02' }),
    seedlingRow({ id: 'seedling-c1', plotId: SEED_IDS.plotC, species: '无瓣海桑', source: '外购', spec: '60cm 营养袋苗', quantity: 4400, arrivalDate: '2024-03-12' }),
    seedlingRow({ id: 'seedling-c2', plotId: SEED_IDS.plotC, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 3900, arrivalDate: '2024-03-16' }),
  ];

  // ---------------- 栽植记录（每地块 2 条，引用真实苗木批次） ----------------
  const plantings: Planting[] = [
    plantingRow({ id: 'planting-a1', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a1', plantDate: '2024-04-12', spacingM: 1, count: 3000, operator: '东港一班' }),
    plantingRow({ id: 'planting-a2', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a2', plantDate: '2024-04-15', spacingM: 0.8, count: 2200, operator: '东港二班' }),
    plantingRow({ id: 'planting-b1', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b1', plantDate: '2024-05-06', spacingM: 1.2, count: 1800, operator: '西湾一班' }),
    plantingRow({ id: 'planting-b2', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b2', plantDate: '2024-05-09', spacingM: 1, count: 1500, operator: '西湾二班' }),
    plantingRow({ id: 'planting-c1', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c1', plantDate: '2024-03-20', spacingM: 1.5, count: 4200, operator: '北屿一班' }),
    plantingRow({ id: 'planting-c2', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c2', plantDate: '2024-03-24', spacingM: 1.2, count: 3800, operator: '北屿二班' }),
  ];

  // 各地块栽植总株数，用于派生成活率
  const totalByPlot: Record<string, number> = {
    [SEED_IDS.plotA]: 5200,
    [SEED_IDS.plotB]: 3300,
    [SEED_IDS.plotC]: 8000,
  };

  // ---------------- 验收记录（覆盖露滩有效 / 涨潮硬凑 / 挂起 / 定级锁版本） ----------------
  const surveys: Survey[] = [
    surveyRow({ id: 'survey-a1', plotId: SEED_IDS.plotA, round: 1, date: '2024-06-20', startAt: '08:30', endAt: '11:00', aliveCount: 4680, avgHeightCm: 62, tideStatus: 'exposed', basisVersion: 1 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a2', plotId: SEED_IDS.plotA, round: 2, date: '2024-09-18', startAt: '09:00', endAt: '11:10', aliveCount: 4420, avgHeightCm: 78, tideStatus: 'exposed', basisVersion: 1 }, totalByPlot[SEED_IDS.plotA]),
    // 下午作业落在早上露滩段之外，未确认 -> 挂起待复核（挂起期间不生成补植计划）
    surveyRow({ id: 'survey-a3', plotId: SEED_IDS.plotA, round: 3, date: '2025-03-15', startAt: '14:00', endAt: '16:30', aliveCount: 4108, avgHeightCm: 96, tideStatus: 'suspended' }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-b1', plotId: SEED_IDS.plotB, round: 1, date: '2024-07-05', startAt: '06:30', endAt: '08:50', aliveCount: 2772, avgHeightCm: 41, tideStatus: 'exposed', basisVersion: 1 }, totalByPlot[SEED_IDS.plotB]),
    // 涨潮硬凑照收：作业在下午、露滩在清晨，仍照常定级
    surveyRow({ id: 'survey-b2', plotId: SEED_IDS.plotB, round: 2, date: '2024-10-12', startAt: '13:30', endAt: '16:00', aliveCount: 2112, avgHeightCm: 55, tideStatus: 'forced', basisVersion: 1 }, totalByPlot[SEED_IDS.plotB]),
    // 定级后站点当天时段改成 v2：留原值，标依据 v1
    surveyRow({ id: 'survey-c1', plotId: SEED_IDS.plotC, round: 1, date: '2024-05-28', startAt: '05:40', endAt: '07:40', aliveCount: 7680, avgHeightCm: 70, tideStatus: 'exposed', manualGrade: 'excellent', basisVersion: 1 }, totalByPlot[SEED_IDS.plotC]),
    surveyRow({ id: 'survey-c2', plotId: SEED_IDS.plotC, round: 2, date: '2024-08-30', startAt: '09:00', endAt: '11:30', aliveCount: 7440, avgHeightCm: 88, tideStatus: 'exposed', basisVersion: 2 }, totalByPlot[SEED_IDS.plotC]),
  ];

  // ---------------- 补植计划（每地块 1 条，覆盖三种状态） ----------------
  const replants: Replant[] = [
    replantRow({ id: 'replant-a1', plotId: SEED_IDS.plotA, missingCount: 1092, planDate: '2025-04-10', species: '秋茄', state: '待补植' }),
    replantRow({ id: 'replant-b1', plotId: SEED_IDS.plotB, missingCount: 1188, planDate: '2025-04-18', species: '白骨壤', state: '已补植' }),
    replantRow({ id: 'replant-c1', plotId: SEED_IDS.plotC, missingCount: 560, planDate: '2024-11-05', species: '无瓣海桑', state: '已复核' }),
  ];

  const tables = [
    db.plots,
    db.seedlings,
    db.plantings,
    db.surveys,
    db.replants,
    db.tideStations,
    db.tideWindows,
  ];
  await db.transaction('rw', tables, async () => {
    await db.tideStations.bulkPut(stations);
    await db.tideWindows.bulkPut(windows);
    await db.plots.bulkPut(plots);
    await db.seedlings.bulkPut(seedlings);
    await db.plantings.bulkPut(plantings);
    await db.surveys.bulkPut(surveys);
    await db.replants.bulkPut(replants);
  });
}
