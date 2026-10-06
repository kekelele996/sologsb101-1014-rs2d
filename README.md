# 红树林修复地块成活率跟踪台（sologsb101-1014）

面向红树林修复项目的现场管理人员：按地块登记苗木批次与栽植记录，分次验收成活株数与株高，
按测次生成成活率趋势，低于阈值时生成补植计划并回写地块缺株数。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22814**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbmangrove` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18 | 函数组件 + Hooks |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| UI 组件库 | Ant Design 5 | 表格、表单、弹窗、日期选择、消息提示 |
| 图标 | @ant-design/icons | |
| 构建 | Vite 5 | 开发端口与宿主端口一致（22814） |
| 路由 | React Router 6 | `createBrowserRouter` + 路由懒加载 |
| 状态管理 | Zustand 4 | 跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbmangrove`，含 v1 → v2 → v3 升级迁移 |
| 时间处理 | dayjs | |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1014/
├── README.md
├── docker-compose.yml          # name: gbmangrove，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # 入口：ConfigProvider + RouterProvider
        ├── App.tsx             # 外壳：侧边导航 + 当前地块上下文 + 数据库初始化
        ├── styles/main.css
        ├── types/              # plot.ts seedling.ts planting.ts survey.ts replant.ts tide.ts
        ├── stores/             # plotStore.ts surveyStore.ts replantStore.ts tideStore.ts
        ├── components/common/  # RateTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx TideStatusTag.tsx
        ├── components/tide/    # StationWindowsPane.tsx ReconcilePane.tsx SchedulePane.tsx
        ├── hooks/              # useSurvivalRate.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面（含潮位露滩对账台 TideBoard）
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        └── utils/              # rate.ts db.ts export.ts seed.ts id.ts tide.ts tideImport.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/plots` | `pages/PlotList.tsx` | 修复地块台账：新建/编辑/级联删除、按潮位带与底质筛选、回显栽植总株数与最新成活率 |
| `/plots/:id/seedlings` | `pages/SeedlingBoard.tsx` | 苗木批次与来源登记、批次数量累计校验（含密度提示） |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | 栽植记录：录株距与株数、按面积与株距校验密度合理性 |
| `/surveys` | `pages/SurveyBoard.tsx` | 成活率与株高验收台：按测次录入（含作业起止时刻）、自动算成活率、低于阈值告警、潮位对账状态、批量调整成活率等级 |
| `/tides` | `pages/TideBoard.tsx` | 潮位露滩与外业排期对账台：潮位站与每天露滩时段维护、潮位表 CSV 导入（只重试潮位侧）、排期前按地块+日期对账、外业排测次（一段排不下顺到下一段，排不下挂起） |
| `/replants` | `pages/ReplantPlan.tsx` | 补植计划：状态流转（待补植→已补植→已复核）、行内草稿、JSON 导入导出、结构版本查看（挂起期间不生成补植计划） |

`/` 重定向到 `/plots`，未匹配路径统一回落到 `/plots`。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/seedlings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「地块不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbmangrove`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引并执行 `.upgrade()` 迁移，
  `version(3)` 增加潮位侧两表并给地块 / 测次补潮位字段：
  * v2：为 `plots` 增加 `updatedAt`、`surveys` 增加 `[plotId+round]` 复合索引、`plantings` 增加 `spacingM` 索引等；
    回填 `revision` / `createdAt` / `updatedAt`；为 `plots` 补齐 `missingCount`、`lastReplantDate` 回写字段；
    为 `surveys` 补齐 `grade`、`gradeManual` 字段（按 `survivalRate` 自动判定等级）。
  * v3：新增 `tideStations` / `tideWindows` 两表；`plots` 增加 `tideStationId`（挂对账站）、`surveyDurationMin`（排期时长）；
    `surveys` 增加 `startAt` / `endAt`（作业起止时刻）、`timeSource`（时刻来源）、`tideStatus`（对账状态）、
    `tideBasisVersion`（定级依据的潮位表版本）。
* **历史测次升级口径**：已有数据没有作业时刻，升级时**按测次日期补一条时刻来源**——
  日期合法 → `历史日期补录`（`legacyValid` 历史有效，仍可看）；补不上 → `无法补录`（`legacyReadonly` 历史只读，只读留着）。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `plots` | id | name, tideZone, substrate, restoreMode, state, tideStationId, createdAt, updatedAt |
  | `seedlings` | id | plotId, species, source, arrivalDate, quantity |
  | `plantings` | id | plotId, seedlingId, plantDate, spacingM |
  | `surveys` | id | plotId, [plotId+round], date, grade, tideStatus |
  | `replants` | id | plotId, planDate, state, species |
  | `tideStations` | id | code, name, level |
  | `tideWindows` | id | stationId, [stationId+date], date, version |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **潮位站 / 地块 → 苗木批次 → 栽植 / 露滩时段 → 验收 → 补植** 三层互相引用：
  * 3 个潮位站（东港 / 西湾 / 北屿，北屿站已到第 2 版），3 个地块各自挂站并配置排期时长；
  * 3 个地块（东港南堤 3 号地块 / 西湾滩涂 A 区 / 北屿外滩 B 区），覆盖三种潮位带与三种底质；
  * 6 个苗木批次（每地块 2 批）、6 条栽植记录（每地块 2 条，引用真实批次 id）；
  * 7 条验收记录覆盖全部潮位对账状态：露滩有效、涨潮硬凑（西湾第 2 测次照收）、挂起待复核（东港第 3 测次）、
    定级后潮位表改版留原值并标依据 v1（北屿第 1 测次）；
  * 3 条补植计划（覆盖待补植 / 已补植 / 已复核三种状态）。
  * 固定 id 如 `plot-donggang-3`、`plot-xiwan-a`、`plot-beiyu-b`、`tide-donggang` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的地块 id」这一界面偏好，不存业务数据。
* 删除地块会**级联清理**其下的苗木批次、栽植记录、验收记录与补植计划（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22814
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **成活率** = 成活株数 ÷ 该地块栽植总株数 × 100%（`src/utils/rate.ts` 统一口径）。
* **成活率等级**：≥ 85% 优，70%–85% 良，50%–70% 一般，< 50% 差；低于 50% 视为告警，建议生成补植计划。
* **密度合理性**：平均单株占地面积需落在 0.6–12 ㎡/株；过密/过疏都会在栽植记录页给出提示。
* **补植回写**：补植状态推进到「已补植」时，自动扣减地块缺株数、写入最近补植日期，
  并按「原成活株数 + 本次补植株数」重算最新一次验收的成活率。
* **露滩对账与排期**：
  * 红树林地块得等退潮露滩才能下滩验收；潮位监测站按站点维护每天露滩时段，外业验收队按地块排测次，两边各记各的，
    排期前在 `/tides` 按 **地块 + 日期** 对账。
  * 测次带作业起止时刻，完整落进所属站当天某段露滩时段才是「露滩有效」；**涨潮硬凑的也照收**（标「涨潮硬凑」，仍定级）；
    停在时段外、未确认的「挂起待复核」。挂起 / 失效 / 历史只读测次不计入成活统计，**挂起期间不生成补植计划**。
  * 外业排期贪心装箱：当前露滩段排不下的地块**顺到下一段**，区间内所有段都排不下的**挂起等复核**；
    排定后可带作业时刻直接跳转验收台录入。
  * **潮位站改动当天时段**即发布新版：未定级测次对不上新时段会失效重算（`已失效重算`）；
    **已定级的留原值并标依据哪一版**（`tideBasisVersion`）。
  * **潮位表 CSV 导入失败只重试潮位侧**：导入只开 `tideStations` / `tideWindows` 事务，
    坏行逐条列出可「只重试潮位侧」，外业地块 / 测次 / 排期照旧。
  * CSV 列：站点编码, 站点名称, 潮位带(低/中/高), 日期(YYYY-MM-DD), 露滩开始(HH:mm), 露滩结束(HH:mm)，支持跨午夜时段。
  * **历史数据升级**：已有测次没有作业时刻，升级时按测次日期补「历史日期补录」来源（历史有效）；补不上的「无法补录」只读留着。
