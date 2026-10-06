/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：地块 → 苗木批次 / 栽植 → 验收 → 补植
 * 所有 id 固定，保证 /plots/:id/seedlings、/plots/:id/plantings 深链一定命中真实数据。
 */
import { db, ROW_REVISION } from './db';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant } from '../types/replant';
import type { TideImport, TideSource, TideStation, TideWindow } from '../types/tide';
import { calcSurvivalRate, rateLevel } from './rate';

const SEED_TIME = '2025-01-06T02:00:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  plotA: 'plot-donggang-3',
  plotB: 'plot-xiwan-a',
  plotC: 'plot-beiyu-b',
  stationA: 'tide-station-donggang',
  stationB: 'tide-station-xiwan',
  stationC: 'tide-station-beiyu',
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

function surveyRow(
  row: Omit<
    Survey,
    | 'createdAt'
    | 'updatedAt'
    | 'revision'
    | 'grade'
    | 'gradeManual'
    | 'survivalRate'
    | 'workStartTime'
    | 'workEndTime'
    | 'tideStatus'
    | 'tideWindowVersionId'
    | 'tideSourceId'
    | 'tideCheckedAt'
  > &
    Partial<Pick<Survey, 'workStartTime' | 'workEndTime' | 'tideStatus' | 'tideWindowVersionId' | 'tideSourceId'>>,
  total: number,
): Survey {
  const survivalRate = calcSurvivalRate(row.aliveCount, total);
  return {
    ...row,
    survivalRate,
    grade: rateLevel(survivalRate),
    gradeManual: false,
    workStartTime: row.workStartTime ?? '',
    workEndTime: row.workEndTime ?? '',
    tideStatus: row.tideStatus ?? 'readonly',
    tideWindowVersionId: row.tideWindowVersionId ?? 0,
    tideSourceId: row.tideSourceId ?? '',
    tideCheckedAt: SEED_TIME,
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

  // ---------------- 潮位监测站（3 个，分别对应三个地块） ----------------
  const stations: TideStation[] = [
    {
      id: SEED_IDS.stationA,
      name: '东港潮位站',
      code: 'DONGGANG',
      location: '东港南堤 3 号地块外侧滩涂',
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
      revision: ROW_REVISION,
    },
    {
      id: SEED_IDS.stationB,
      name: '西湾潮位站',
      code: 'XIWAN',
      location: '西湾滩涂 A 区外侧',
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
      revision: ROW_REVISION,
    },
    {
      id: SEED_IDS.stationC,
      name: '北屿潮位站',
      code: 'BEIYU',
      location: '北屿外滩 B 区岬角',
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
      revision: ROW_REVISION,
    },
  ];

  // ---------------- 地块（3 块，覆盖三种潮位带与三种底质） ----------------
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

  // ---------------- 验收记录（每地块 2–3 个测次，带作业起止时刻与露滩核对） ----------------
  // 露滩时段：东港 / 西湾 / 北屿三站在各验收日的窗口；
  // 其中 survey-a3 作业落在时段外 → 挂起；survey-b2 当天无时段 → 只读（补不上来源）。
  const windows: TideWindow[] = [
    // 东港站
    { id: 'window-a1', stationId: SEED_IDS.stationA, date: '2024-06-20', startTime: '06:30', endTime: '09:30', version: 1, sourceId: 'manual', createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION },
    { id: 'window-a2', stationId: SEED_IDS.stationA, date: '2024-09-18', startTime: '15:00', endTime: '18:00', version: 1, sourceId: 'manual', createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION },
    { id: 'window-a3', stationId: SEED_IDS.stationA, date: '2025-03-15', startTime: '07:00', endTime: '10:00', version: 1, sourceId: 'manual', createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION },
    // 西湾站（survey-b2 日期 2024-10-12 故意不排时段 → 只读）
    { id: 'window-b1', stationId: SEED_IDS.stationB, date: '2024-07-05', startTime: '07:30', endTime: '10:30', version: 1, sourceId: 'manual', createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION },
    // 北屿站
    { id: 'window-c1', stationId: SEED_IDS.stationC, date: '2024-05-28', startTime: '08:00', endTime: '11:00', version: 1, sourceId: 'manual', createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION },
    { id: 'window-c2', stationId: SEED_IDS.stationC, date: '2024-08-30', startTime: '16:00', endTime: '19:00', version: 1, sourceId: 'manual', createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION },
  ];

  const surveys: Survey[] = [
    surveyRow(
      { id: 'survey-a1', plotId: SEED_IDS.plotA, round: 1, date: '2024-06-20', aliveCount: 4680, avgHeightCm: 62, workStartTime: '07:00', workEndTime: '09:00', tideStatus: 'normal', tideWindowVersionId: 1, tideSourceId: 'tidesrc-seed-a1' },
      totalByPlot[SEED_IDS.plotA],
    ),
    surveyRow(
      { id: 'survey-a2', plotId: SEED_IDS.plotA, round: 2, date: '2024-09-18', aliveCount: 4420, avgHeightCm: 78, workStartTime: '15:30', workEndTime: '17:30', tideStatus: 'normal', tideWindowVersionId: 1, tideSourceId: 'tidesrc-seed-a2' },
      totalByPlot[SEED_IDS.plotA],
    ),
    surveyRow(
      // 作业 10:30–12:00 落在露滩时段 07:00–10:00 之外 → 挂起等复核
      { id: 'survey-a3', plotId: SEED_IDS.plotA, round: 3, date: '2025-03-15', aliveCount: 4108, avgHeightCm: 96, workStartTime: '10:30', workEndTime: '12:00', tideStatus: 'suspended', tideWindowVersionId: 1, tideSourceId: 'tidesrc-seed-a3' },
      totalByPlot[SEED_IDS.plotA],
    ),
    surveyRow(
      { id: 'survey-b1', plotId: SEED_IDS.plotB, round: 1, date: '2024-07-05', aliveCount: 2772, avgHeightCm: 41, workStartTime: '08:00', workEndTime: '10:00', tideStatus: 'normal', tideWindowVersionId: 1, tideSourceId: 'tidesrc-seed-b1' },
      totalByPlot[SEED_IDS.plotB],
    ),
    surveyRow(
      // 当天无露滩时段，补不上来源 → 只读留着
      { id: 'survey-b2', plotId: SEED_IDS.plotB, round: 2, date: '2024-10-12', aliveCount: 2112, avgHeightCm: 55, tideStatus: 'readonly', tideWindowVersionId: 0, tideSourceId: '' },
      totalByPlot[SEED_IDS.plotB],
    ),
    surveyRow(
      { id: 'survey-c1', plotId: SEED_IDS.plotC, round: 1, date: '2024-05-28', aliveCount: 7680, avgHeightCm: 70, workStartTime: '08:30', workEndTime: '10:30', tideStatus: 'normal', tideWindowVersionId: 1, tideSourceId: 'tidesrc-seed-c1' },
      totalByPlot[SEED_IDS.plotC],
    ),
    surveyRow(
      { id: 'survey-c2', plotId: SEED_IDS.plotC, round: 2, date: '2024-08-30', aliveCount: 7440, avgHeightCm: 88, workStartTime: '16:30', workEndTime: '18:30', tideStatus: 'normal', tideWindowVersionId: 1, tideSourceId: 'tidesrc-seed-c2' },
      totalByPlot[SEED_IDS.plotC],
    ),
  ];

  // ---------------- 对账来源（测次 ↔ 露滩时段，标依据哪一版） ----------------
  const tideSources: TideSource[] = [
    { id: 'tidesrc-seed-a1', surveyId: 'survey-a1', plotId: SEED_IDS.plotA, stationId: SEED_IDS.stationA, windowId: 'window-a1', windowVersionId: 1, date: '2024-06-20', sourceType: 'manual', createdAt: SEED_TIME },
    { id: 'tidesrc-seed-a2', surveyId: 'survey-a2', plotId: SEED_IDS.plotA, stationId: SEED_IDS.stationA, windowId: 'window-a2', windowVersionId: 1, date: '2024-09-18', sourceType: 'manual', createdAt: SEED_TIME },
    { id: 'tidesrc-seed-a3', surveyId: 'survey-a3', plotId: SEED_IDS.plotA, stationId: SEED_IDS.stationA, windowId: 'window-a3', windowVersionId: 1, date: '2025-03-15', sourceType: 'manual', createdAt: SEED_TIME },
    { id: 'tidesrc-seed-b1', surveyId: 'survey-b1', plotId: SEED_IDS.plotB, stationId: SEED_IDS.stationB, windowId: 'window-b1', windowVersionId: 1, date: '2024-07-05', sourceType: 'manual', createdAt: SEED_TIME },
    { id: 'tidesrc-seed-c1', surveyId: 'survey-c1', plotId: SEED_IDS.plotC, stationId: SEED_IDS.stationC, windowId: 'window-c1', windowVersionId: 1, date: '2024-05-28', sourceType: 'manual', createdAt: SEED_TIME },
    { id: 'tidesrc-seed-c2', surveyId: 'survey-c2', plotId: SEED_IDS.plotC, stationId: SEED_IDS.stationC, windowId: 'window-c2', windowVersionId: 1, date: '2024-08-30', sourceType: 'manual', createdAt: SEED_TIME },
  ];

  // ---------------- 潮位表导入批次（演示一次成功导入） ----------------
  const tideImports: TideImport[] = [
    {
      id: 'tide-import-seed',
      fileName: '2024 年度露滩时段表.xlsx',
      status: 'success',
      rowCount: 6,
      error: '',
      importedAt: SEED_TIME,
      retriedAt: '',
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
      revision: ROW_REVISION,
    },
  ];

  // ---------------- 补植计划（每地块 1 条，覆盖三种状态） ----------------
  const replants: Replant[] = [
    replantRow({ id: 'replant-a1', plotId: SEED_IDS.plotA, missingCount: 1092, planDate: '2025-04-10', species: '秋茄', state: '待补植' }),
    replantRow({ id: 'replant-b1', plotId: SEED_IDS.plotB, missingCount: 1188, planDate: '2025-04-18', species: '白骨壤', state: '已补植' }),
    replantRow({ id: 'replant-c1', plotId: SEED_IDS.plotC, missingCount: 560, planDate: '2024-11-05', species: '无瓣海桑', state: '已复核' }),
  ];

  await db.transaction(
    'rw',
    [
      db.plots,
      db.seedlings,
      db.plantings,
      db.surveys,
      db.replants,
      db.tideStations,
      db.tideWindows,
      db.tideSources,
      db.tideImports,
    ],
    async () => {
      await db.plots.bulkPut(plots);
      await db.seedlings.bulkPut(seedlings);
      await db.plantings.bulkPut(plantings);
      await db.surveys.bulkPut(surveys);
      await db.replants.bulkPut(replants);
      await db.tideStations.bulkPut(stations);
      await db.tideWindows.bulkPut(windows);
      await db.tideSources.bulkPut(tideSources);
      await db.tideImports.bulkPut(tideImports);
    },
  );
}
