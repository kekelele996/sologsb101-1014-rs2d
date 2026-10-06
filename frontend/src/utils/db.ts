/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - v3：新增潮位监测站 / 露滩时段两表；地块挂潮位站；测次补作业时刻与潮位对账字段
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { TideStation, TideWindow } from '../types/tide';
import { rateLevel } from './rate';
import { evaluateTideStatus, findFittingWindow } from './tide';
import { nowIso, today } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;
  tideStations!: Table<TideStation, string>;
  tideWindows!: Table<TideWindow, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：潮位监测站 / 露滩时段 + 测次作业时刻与对账字段 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots:
          'id, name, tideZone, substrate, restoreMode, state, tideStationId, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // tideStatus：验收台按对账状态过滤；tideBasisVersion：定级依据的潮位表版本
        surveys: 'id, plotId, [plotId+round], date, grade, tideStatus',
        replants: 'id, plotId, planDate, state, species',
        tideStations: 'id, code, name, level',
        // 复合索引 [stationId+date]：按站点 + 日期取当天露滩时段
        tideWindows: 'id, stationId, [stationId+date], date, version',
      })
      .upgrade(async (tx) => {
        // 地块挂潮位站 + 排期时长（历史地块先留空，由用户在地块台账里补挂）
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.tideStationId !== 'string') row.tideStationId = '';
          if (typeof row.surveyDurationMin !== 'number') row.surveyDurationMin = 0;
        });
        // 历史验收记录没有作业时刻：按测次日期补一条「时刻来源」。
        // 日期合法 -> 历史日期补录（历史有效，仍可看）；补不上 -> 无法补录（只读留着）。
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const hasDate = typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date as string);
          if (typeof row.startAt !== 'string') row.startAt = '';
          if (typeof row.endAt !== 'string') row.endAt = '';
          if (typeof row.timeSource !== 'string') {
            row.timeSource = hasDate ? '历史日期补录' : '无法补录';
          }
          if (typeof row.tideStatus !== 'string') {
            row.tideStatus = hasDate ? 'legacyValid' : 'legacyReadonly';
          }
          if (typeof row.tideBasisVersion !== 'number') row.tideBasisVersion = 0;
        });
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/** 删除地块并级联清理其下苗木批次、栽植、验收与补植计划（潮位站为站点公共数据，不删） */
export async function removePlot(id: string): Promise<void> {
  await db.transaction(
    'rw',
    db.plots,
    db.seedlings,
    db.plantings,
    db.surveys,
    db.replants,
    async () => {
      await db.seedlings.where('plotId').equals(id).delete();
      await db.plantings.where('plotId').equals(id).delete();
      await db.surveys.where('plotId').equals(id).delete();
      await db.replants.where('plotId').equals(id).delete();
      await db.plots.delete(id);
    },
  );
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.plantings, async () => {
    // 该批次已被栽植记录引用时一并清理，避免出现悬空引用
    await db.plantings.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

/**
 * 按地块 + 日期取所属潮位站当天的露滩时段（排期前对账用）。
 * 地块未挂站或当天无时段时返回空数组。
 */
export async function windowsForPlotDay(plotId: string, date: string): Promise<TideWindow[]> {
  const plot = await db.plots.get(plotId);
  if (!plot || plot.tideStationId === '') return [];
  return db.tideWindows.where('[stationId+date]').equals([plot.tideStationId, date]).toArray();
}

/**
 * 落库前对账：依据地块所属潮位站「当天时段」重算测次的潮位状态与定级版本。
 * - 作业起止落进当天某段 -> 露滩有效，锁定定级版本为该段版本；
 * - 时段外且硬凑 -> 涨潮硬凑（照收），版本取站点当前版本；
 * - 时段外未硬凑 -> 挂起待复核（不锁版本，挂起期间不生成补植计划）。
 * 已定级（gradeManual）的记录不在此处改动，保留原值与依据版本。
 */
export async function reconcileSurvey(row: Survey, forced: boolean): Promise<Survey> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  const plot = await db.plots.get(row.plotId);
  const station = plot?.tideStationId ? await db.tideStations.get(plot.tideStationId) : undefined;
  const dayWindows = plot?.tideStationId
    ? await db.tideWindows.where('[stationId+date]').equals([plot.tideStationId, row.date]).toArray()
    : [];
  const hasTimes = row.startAt !== '' && row.endAt !== '';
  const tideStatus = evaluateTideStatus({
    hasTimes,
    forced,
    legacy: false,
    dayWindows,
    startAt: row.startAt,
    endAt: row.endAt,
  });
  let tideBasisVersion = 0;
  if (tideStatus === 'exposed') {
    const win = findFittingWindow(row.startAt, row.endAt, dayWindows);
    tideBasisVersion = win?.version ?? station?.tideTableVersion ?? 0;
  } else if (tideStatus === 'forced') {
    tideBasisVersion = station?.tideTableVersion ?? 0;
  }
  return {
    ...row,
    grade,
    tideStatus,
    tideBasisVersion,
    timeSource: row.timeSource === '无法补录' ? '无法补录' : hasTimes ? '现场记录' : row.timeSource,
  };
}

export async function putSurvey(row: Survey): Promise<void> {
  await db.surveys.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 潮位站改动「当天时段」后的重算（在同一事务内调用）。
 * - 已定级（gradeManual）的测次：留原值，依据版本保持定级时锁定的那一版；
 * - 历史数据（legacy*）：不动；
 * - 涨潮硬凑：人工照收的选择，不动；
 * - 其余未定级测次按新时段重判：对得上 -> 露滩有效；原本露滩有效现在对不上 -> 已失效重算；
 *   原本挂起现在对得上 -> 解除挂起；仍对不上 -> 维持挂起。
 */
async function recomputeSurveysForStationDay(
  stationId: string,
  date: string | null,
  nextVersion: number,
): Promise<void> {
  const plotRows = await db.plots.where('tideStationId').equals(stationId).toArray();
  if (plotRows.length === 0) return;
  for (const plot of plotRows) {
    let surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    if (date !== null) surveys = surveys.filter((row) => row.date === date);
    for (const survey of surveys) {
      if (survey.gradeManual) continue; // 已定级：留原值、保留依据版本
      if (survey.tideStatus === 'legacyValid' || survey.tideStatus === 'legacyReadonly') continue;
      if (survey.tideStatus === 'forced') continue; // 硬凑照收，不随潮位表变动
      const dayWindows = await db.tideWindows
        .where('[stationId+date]')
        .equals([stationId, survey.date])
        .toArray();
      const hasTimes = survey.startAt !== '' && survey.endAt !== '';
      const fit = hasTimes && findFittingWindow(survey.startAt, survey.endAt, dayWindows) !== null;
      if (fit) {
        await db.surveys.update(survey.id, {
          tideStatus: 'exposed',
          tideBasisVersion: nextVersion,
          updatedAt: nowIso(),
        });
      } else if (survey.tideStatus === 'exposed') {
        // 改动前露滩有效、改动后对不上：失效，等待重算 / 复核
        await db.surveys.update(survey.id, {
          tideStatus: 'invalidated',
          tideBasisVersion: 0,
          updatedAt: nowIso(),
        });
      }
      // suspended 且仍对不上：维持挂起
    }
  }
}

/** 批量调整成活率等级（人工复核覆盖，同时锁定定级依据的潮位表版本） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next: Survey[] = [];
  for (const row of rows) {
    if (row === undefined) continue;
    let basis = row.tideBasisVersion;
    if (basis === 0) {
      const plot = await db.plots.get(row.plotId);
      const station = plot?.tideStationId ? await db.tideStations.get(plot.tideStationId) : undefined;
      basis = station?.tideTableVersion ?? 0;
    }
    next.push({ ...row, grade, gradeManual: true, tideBasisVersion: basis, updatedAt: stamp });
  }
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------------ 潮位监测站 ------------------------------ */

export async function listTideStations(): Promise<TideStation[]> {
  const rows = await db.tideStations.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

export async function putTideStation(row: TideStation): Promise<void> {
  await db.tideStations.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeTideStation(id: string): Promise<void> {
  await db.transaction('rw', db.tideStations, db.tideWindows, db.plots, async () => {
    // 解绑挂在该站的地块（各记各的：删站不动外业测次，只摘掉对账关系）
    await db.plots.where('tideStationId').equals(id).modify({ tideStationId: '' });
    await db.tideWindows.where('stationId').equals(id).delete();
    await db.tideStations.delete(id);
  });
}

export async function listTideWindows(stationId?: string): Promise<TideWindow[]> {
  const rows = stationId ? await db.tideWindows.where('stationId').equals(stationId).toArray() : await db.tideWindows.toArray();
  return rows.sort((a, b) =>
    a.date.localeCompare(b.date) !== 0 ? a.date.localeCompare(b.date) : a.startAt.localeCompare(b.startAt),
  );
}

/**
 * 保存某站「某一天」的露滩时段（整段覆盖当天）。
 * 改动当天时段即视为发布新一版潮位表：站点版本 +1，新时段写入新版本，
 * 随后在同一事务里让该站该天「未定级」的测次失效重算。
 */
export async function replaceStationDayWindows(
  stationId: string,
  date: string,
  windows: Array<Pick<TideWindow, 'startAt' | 'endAt' | 'source'>>,
): Promise<number> {
  let nextVersion = 0;
  await db.transaction('rw', db.tideStations, db.tideWindows, db.plots, db.surveys, async () => {
    const station = await db.tideStations.get(stationId);
    if (!station) throw new Error('潮位监测站不存在');
    nextVersion = station.tideTableVersion + 1;
    await db.tideWindows.where('[stationId+date]').equals([stationId, date]).delete();
    const stamp = nowIso();
    const rows: TideWindow[] = windows.map((win, index) => ({
      id: `tidewin-${stationId}-${date}-${index}-${Date.now().toString(36)}`,
      stationId,
      date,
      startAt: win.startAt,
      endAt: win.endAt,
      source: win.source,
      version: nextVersion,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }));
    await db.tideWindows.bulkPut(rows);
    await db.tideStations.update(stationId, {
      tideTableVersion: nextVersion,
      updatedAt: stamp,
      note: `第 ${nextVersion} 版：${date} 当天 ${rows.length} 段露滩时段`,
    });
    await recomputeSurveysForStationDay(stationId, date, nextVersion);
  });
  return nextVersion;
}

/**
 * 潮位表整表导入：只开潮位侧两表的事务，外业地块 / 测次 / 排期一律不参与。
 * 因此导入失败（解析或事务异常）时只会重试潮位侧，外业排期照旧可用。
 * 返回每条解析失败的原因，便于在页面上逐条重试。
 */
export interface TideImportRow {
  code: string;
  stationName: string;
  level: TideStation['level'];
  date: string;
  startAt: string;
  endAt: string;
}

export interface TideImportFailure {
  row: TideImportRow | null;
  line: number;
  reason: string;
}

export interface TideImportResult {
  ok: boolean;
  stationCount: number;
  windowCount: number;
  versionByStation: Record<string, number>;
  failures: TideImportFailure[];
}

export async function importTideTable(
  rows: TideImportRow[],
  failures: TideImportFailure[] = [],
): Promise<TideImportResult> {
  // 解析阶段就失败的行不进事务
  const result: TideImportResult = {
    ok: false,
    stationCount: 0,
    windowCount: 0,
    versionByStation: {},
    failures,
  };
  const versionByStation: Record<string, number> = {};
  await db.transaction('rw', db.tideStations, db.tideWindows, async () => {
    const byStation = new Map<string, TideImportRow[]>();
    for (const row of rows) {
      const list = byStation.get(row.code) ?? [];
      list.push(row);
      byStation.set(row.code, list);
    }
    for (const [code, list] of byStation) {
      const first = list[0];
      let station = await db.tideStations.where('code').equals(code).first();
      const stamp = nowIso();
      if (!station) {
        station = {
          id: `tide-${code}`,
          code,
          name: first.stationName,
          level: first.level,
          tideTableVersion: 1,
          note: '潮位表导入',
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        };
      } else {
        station = { ...station, tideTableVersion: station.tideTableVersion + 1, name: first.stationName, level: first.level };
      }
      await db.tideStations.put(station);
      versionByStation[code] = station.tideTableVersion;

      // 按日期分组：导入表覆盖涉及到的每一天
      const days = new Map<string, TideImportRow[]>();
      for (const item of list) {
        const day = days.get(item.date) ?? [];
        day.push(item);
        days.set(item.date, day);
      }
      for (const [date, dayRows] of days) {
        await db.tideWindows.where('[stationId+date]').equals([station.id, date]).delete();
        await db.tideWindows.bulkPut(
          dayRows.map((item, index) => ({
            id: `tidewin-${station!.id}-${date}-${index}-${Date.now().toString(36)}-${index}`,
            stationId: station!.id,
            date,
            startAt: item.startAt,
            endAt: item.endAt,
            source: '潮位表导入' as const,
            version: station!.tideTableVersion,
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          })),
        );
      }
      result.stationCount += 1;
      result.windowCount += list.length;
    }
  });
  result.ok = true;
  result.versionByStation = versionByStation;
  return result;
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写：
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的总株数重算最新一次验收的成活率。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;

    const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
    await db.plots.update(plot.id, {
      missingCount: nextMissing,
      lastReplantDate: today(),
      updatedAt: nowIso(),
    });

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    if (surveys.length === 0) return;
    const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
    // 补植后按「原成活株数 + 本次补植株数」重新计算成活率
    const aliveAfter = latest.aliveCount + replant.missingCount;
    const rate = total > 0 ? Math.round(Math.min(100, (aliveAfter / total) * 100) * 10) / 10 : latest.survivalRate;
    await db.surveys.update(latest.id, {
      aliveCount: aliveAfter,
      survivalRate: rate,
      grade: latest.gradeManual ? latest.grade : rateLevel(rate),
      updatedAt: nowIso(),
    });
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核），推进到「已补植」时触发回写 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
  if (next === '已补植') {
    await applyReplantCompletion(replantId);
  }
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
  tideStations: TideStation[];
  tideWindows: TideWindow[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, tideStations, tideWindows] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.tideStations.toArray(),
    db.tideWindows.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
    tideStations,
    tideWindows,
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  // 旧版（v1/v2）存档缺少 v3 潮位字段时补默认值，避免读出来后对账逻辑拿到 undefined
  const normalizePlot = (row: Plot): Plot => ({
    ...row,
    tideStationId: typeof row.tideStationId === 'string' ? row.tideStationId : '',
    surveyDurationMin: typeof row.surveyDurationMin === 'number' ? row.surveyDurationMin : 0,
    revision: ROW_REVISION,
  });
  const normalizeSurvey = (row: Survey): Survey => ({
    ...row,
    startAt: typeof row.startAt === 'string' ? row.startAt : '',
    endAt: typeof row.endAt === 'string' ? row.endAt : '',
    timeSource: row.timeSource ?? '无法补录',
    tideStatus:
      row.tideStatus ?? (typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? 'legacyValid' : 'legacyReadonly'),
    tideBasisVersion: typeof row.tideBasisVersion === 'number' ? row.tideBasisVersion : 0,
    revision: ROW_REVISION,
  });
  const tables = [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.tideStations, db.tideWindows];
  await db.transaction('rw', tables, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
      db.tideStations.clear(),
      db.tideWindows.clear(),
    ]);
    await db.plots.bulkPut(snapshot.plots.map(normalizePlot));
    await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.surveys.bulkPut(snapshot.surveys.map(normalizeSurvey));
    await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
    // v2 存档没有潮位两表时按空处理，不影响外业数据
    await db.tideStations.bulkPut((snapshot.tideStations ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.tideWindows.bulkPut((snapshot.tideWindows ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  const tables = [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.tideStations, db.tideWindows];
  await db.transaction('rw', tables, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
      db.tideStations.clear(),
      db.tideWindows.clear(),
    ]);
  });
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, tideStations, tideWindows] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.tideStations.count(),
    db.tideWindows.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, tideStations, tideWindows };
}
