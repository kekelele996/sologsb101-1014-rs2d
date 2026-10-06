/**
 * /surveys 成活率与株高验收台
 * 按测次录入成活株数与平均株高，自动算成活率并低于阈值告警；支持批量调整成活率等级。
 * 消费模型：Survey、Plot、Planting；复用组件：<RateTag>、<EmptyPanel>、<StatBadge>
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  RiseOutlined,
  FallOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import RateTag from '../components/common/RateTag';
import StatBadge from '../components/common/StatBadge';
import TideStatusTag from '../components/common/TideStatusTag';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useSurveyStore } from '../stores/surveyStore';
import { db } from '../utils/db';
import {
  RATE_LEVEL_LABEL,
  RATE_LEVEL_OPTIONS,
  TIDE_STATUS_LABEL,
  type RateLevel,
  type Survey,
  type TideStatus,
} from '../types/survey';
import { SURVIVAL_WARN_RATE, percentText } from '../utils/rate';

type SurveyFormValues = {
  plotId: string;
  round: number;
  date: Dayjs;
  range: [Dayjs, Dayjs];
  aliveCount: number;
  avgHeightCm: number;
  forced: boolean;
};

const TIDE_STATUS_FILTER_OPTIONS: TideStatus[] = [
  'exposed',
  'forced',
  'suspended',
  'invalidated',
  'legacyValid',
  'legacyReadonly',
];

export default function SurveyBoard() {
  const { message } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const plots = usePlotStore((state) => state.plots);
  const ready = usePlotStore((state) => state.ready);
  const tideStations = usePlotStore((state) => state.tideStations);
  const tideWindows = usePlotStore((state) => state.tideWindows);
  const statOf = usePlotStore((state) => state.statOf);
  const summaryOf = usePlotStore((state) => state.summaryOf);
  const filters = useSurveyStore((state) => state.filters);
  const setFilters = useSurveyStore((state) => state.setFilters);
  const resetFilters = useSurveyStore((state) => state.resetFilters);
  const selectedIds = useSurveyStore((state) => state.selectedIds);
  const setSelectedIds = useSurveyStore((state) => state.setSelectedIds);
  const gradeDraft = useSurveyStore((state) => state.gradeDraft);
  const setGradeDraft = useSurveyStore((state) => state.setGradeDraft);
  const bulkApplyGrade = useSurveyStore((state) => state.bulkApplyGrade);
  const reviewSurvey = useSurveyStore((state) => state.reviewSurvey);
  const generateReplant = useSurveyStore((state) => state.generateReplant);
  const createSurvey = useSurveyStore((state) => state.createSurvey);
  const updateSurvey = useSurveyStore((state) => state.updateSurvey);
  const deleteSurvey = useSurveyStore((state) => state.deleteSurvey);
  const surveyRevision = useSurveyStore((state) => state.revision);

  const { rows, loading, remove } = useIdbTable<Survey>(db.surveys, { sortByUpdatedAt: false });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Survey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SurveyFormValues>();

  // 从潮位排期页带 plotId/date/start/end 跳来时，自动打开始录弹窗并预填作业时刻
  const prefillKey = searchParams.get('plotId');
  useEffect(() => {
    if (prefillKey && ready) {
      openCreate({
        plotId: searchParams.get('plotId') ?? undefined,
        date: searchParams.get('date') ?? undefined,
        start: searchParams.get('start') ?? undefined,
        end: searchParams.get('end') ?? undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillKey, ready]);

  const stationOfPlot = (plotId: string) => tideStations.find((s) => s.id === plots.find((p) => p.id === plotId)?.tideStationId);

  /** 表单预览：选中地块 + 日期 + 作业时刻时，实时给出对账提示 */
  const formPreview = Form.useWatch([], form) as SurveyFormValues | undefined;
  const previewDayWindows = useMemo(() => {
    if (!formPreview?.plotId || !formPreview.date) return [];
    const plot = plots.find((p) => p.id === formPreview.plotId);
    if (!plot?.tideStationId) return [];
    const dateStr = formPreview.date.format('YYYY-MM-DD');
    return tideWindows
      .filter((win) => win.stationId === plot.tideStationId && win.date === dateStr)
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
  }, [formPreview, plots, tideWindows]);

  const previewFit = useMemo(() => {
    if (!formPreview?.range || previewDayWindows.length === 0) return null;
    const [s, e] = formPreview.range;
    if (!s || !e) return null;
    const startAt = s.format('HH:mm');
    const endAt = e.format('HH:mm');
    const toMin = (hm: string) => {
      const [h, m] = hm.split(':').map(Number);
      return h * 60 + m;
    };
    const fitWin = previewDayWindows.find((win) => {
      const ws = toMin(win.startAt);
      let we = toMin(win.endAt);
      if (we <= ws) we += 24 * 60;
      const js = toMin(startAt);
      let je = toMin(endAt);
      if (je < js) je += 24 * 60;
      return js >= ws && je <= we;
    });
    return fitWin ? fitWin.version : false;
  }, [formPreview, previewDayWindows]);

  const filtered = useMemo(() => {
    void surveyRevision;
    const key = filters.keyword.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (filters.plotId !== 'all' && row.plotId !== filters.plotId) return false;
        if (filters.from !== '' && row.date < filters.from) return false;
        if (filters.to !== '' && row.date > filters.to) return false;
        if (filters.tideStatus !== 'all' && row.tideStatus !== filters.tideStatus) return false;
        if (filters.level !== 'all') {
          const summary = summaryOf(row.plotId);
          const point = summary.points.find((item) => item.surveyId === row.id);
          const level: RateLevel = point?.level ?? row.grade;
          if (level !== filters.level) return false;
        }
        if (key === '') return true;
        const plotName = plots.find((item) => item.id === row.plotId)?.name ?? '';
        return plotName.toLowerCase().includes(key) || row.date.includes(key) || `第${row.round}`.includes(key);
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.round - a.round);
    // surveyRevision 用于写操作后强制重算派生列
  }, [rows, filters, plots, summaryOf, surveyRevision]);

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  const stats = useMemo(() => {
    const rated = plots.filter((plot) => statOf(plot.id).surveyCount > 0);
    const warn = rated.filter((plot) => statOf(plot.id).latestRate < SURVIVAL_WARN_RATE);
    const strong = rated.filter((plot) => statOf(plot.id).latestRate >= 85);
    return {
      ratedCount: rated.length,
      warnCount: warn.length,
      strongCount: strong.length,
      strongPct: rated.length === 0 ? 0 : Math.round((strong.length / rated.length) * 1000) / 10,
      avgRate:
        rated.length === 0
          ? 0
          : Math.round((rated.reduce((acc, plot) => acc + statOf(plot.id).latestRate, 0) / rated.length) * 10) / 10,
    };
  }, [plots, statOf]);

  const openCreate = (prefill?: Partial<{ plotId: string; date: string; start: string; end: string }>): void => {
    const plotId =
      prefill?.plotId ?? (filters.plotId !== 'all' ? filters.plotId : plots.length > 0 ? plots[0].id : '');
    const nextRound = rows.filter((row) => row.plotId === plotId).length + 1;
    setEditing(null);
    const dateDay = prefill?.date ? dayjs(prefill.date) : dayjs();
    form.setFieldsValue({
      plotId,
      round: nextRound,
      date: dateDay,
      range:
        prefill?.start && prefill?.end
          ? [dayjs(`${dateDay.format('YYYY-MM-DD')} ${prefill.start}`), dayjs(`${dateDay.format('YYYY-MM-DD')} ${prefill.end}`)]
          : [dayjs(`${dateDay.format('YYYY-MM-DD')} 08:00`), dayjs(`${dateDay.format('YYYY-MM-DD')} 10:00`)],
      forced: false,
      aliveCount: 0,
      avgHeightCm: 0,
    });
    setOpen(true);
  };

  const openEdit = (row: Survey): void => {
    setEditing(row);
    const day = dayjs(row.date);
    form.setFieldsValue({
      plotId: row.plotId,
      round: row.round,
      date: day,
      range:
        row.startAt && row.endAt
          ? [dayjs(`${row.date} ${row.startAt}`), dayjs(`${row.date} ${row.endAt}`)]
          : [dayjs(`${row.date} 08:00`), dayjs(`${row.date} 10:00`)],
      forced: row.tideStatus === 'forced',
      aliveCount: row.aliveCount,
      avgHeightCm: row.avgHeightCm,
    });
    setOpen(true);
  };

  /** 历史只读（补不上作业时刻来源）的测次只能看，不能改 */
  const isReadonly = (row: Survey | null): boolean => row?.tideStatus === 'legacyReadonly';

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const [startDay, endDay] = values.range;
      const payload = {
        plotId: values.plotId,
        round: values.round,
        date: values.date.format('YYYY-MM-DD'),
        startAt: startDay.format('HH:mm'),
        endAt: endDay.format('HH:mm'),
        forced: values.forced === true,
        aliveCount: values.aliveCount,
        avgHeightCm: values.avgHeightCm,
      };
      if (editing === null) {
        const row = await createSurvey(payload);
        message.success(`已录入第 ${row.round} 测次，成活率 ${row.survivalRate}%（${TIDE_STATUS_LABEL[row.tideStatus]}）`);
        if (row.tideStatus === 'suspended') {
          message.warning('作业落在露滩时段外，已挂起待复核；挂起期间不生成补植计划', 6);
        } else if (row.tideStatus === 'forced') {
          message.info('该测次按涨潮硬凑照收');
        } else if (row.survivalRate < SURVIVAL_WARN_RATE) {
          message.warning(`成活率 ${row.survivalRate}% 低于告警阈值 ${SURVIVAL_WARN_RATE}%，建议生成补植计划`, 6);
        }
      } else {
        await updateSurvey(editing.id, payload);
        message.success('验收记录已更新');
      }
      setOpen(false);
      setSearchParams({});
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkGrade = async (): Promise<void> => {
    const count = await bulkApplyGrade(gradeDraft);
    if (count === 0) {
      message.info('勾选的记录里没有可定级的（挂起 / 失效 / 历史只读需先复核，或未勾选）');
      return;
    }
    message.success(`已把 ${count} 条记录的成活率等级调整为「${RATE_LEVEL_LABEL[gradeDraft]}」`);
  };

  const handleGenerateReplant = async (): Promise<void> => {
    const plotId = filters.plotId !== 'all' ? filters.plotId : plots.length > 0 ? plots[0].id : '';
    if (plotId === '') {
      message.info('请先选择地块');
      return;
    }
    const result = await generateReplant(plotId);
    message.success(result);
  };

  const columns: ColumnsType<Survey> = [
    {
      title: '地块',
      key: 'plot',
      width: 200,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{plotName(record.plotId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            栽植总株数 {statOf(record.plotId).plantTotal.toLocaleString('zh-CN')} 株
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '测次',
      dataIndex: 'round',
      key: 'round',
      width: 84,
      align: 'center',
      render: (value: number) => <Tag color="blue">第 {value} 次</Tag>,
      sorter: (a, b) => a.round - b.round,
    },
    { title: '验收日期', dataIndex: 'date', key: 'date', width: 120, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '作业起止',
      key: 'workRange',
      width: 140,
      render: (_value, record) =>
        record.startAt && record.endAt ? (
          <span>{record.startAt}~{record.endAt}</span>
        ) : (
          <Tooltip title="升级时补不上作业时刻来源，只读留着">
            <Tag color="default">无时刻·只读</Tag>
          </Tooltip>
        ),
    },
    {
      title: '潮位对账',
      key: 'tideStatus',
      width: 175,
      render: (_value, record) => <TideStatusTag status={record.tideStatus} basisVersion={record.tideBasisVersion} />,
    },
    {
      title: '成活株数',
      dataIndex: 'aliveCount',
      key: 'aliveCount',
      width: 100,
      align: 'right',
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '成活率',
      key: 'rate',
      width: 180,
      render: (_value, record) => {
        const summary = summaryOf(record.plotId);
        const point = summary.points.find((item) => item.surveyId === record.id);
        return (
          <RateTag
            rate={point?.rate ?? record.survivalRate}
            level={point?.level ?? record.grade}
            manual={record.gradeManual}
          />
        );
      },
    },
    {
      title: '平均株高',
      dataIndex: 'avgHeightCm',
      key: 'avgHeightCm',
      width: 128,
      align: 'right',
      render: (value: number, record) => {
        const summary = summaryOf(record.plotId);
        const index = summary.points.findIndex((item) => item.surveyId === record.id);
        const previous = index > 0 ? summary.points[index - 1] : null;
        return (
          <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
            <span>{value} cm</span>
            {previous !== null ? (
              <Typography.Text
                type={value >= previous.avgHeightCm ? 'success' : 'danger'}
                style={{ fontSize: 12 }}
              >
                {value >= previous.avgHeightCm ? <RiseOutlined /> : <FallOutlined />}{' '}
                {Math.abs(Math.round((value - previous.avgHeightCm) * 10) / 10)} cm
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '等级来源',
      key: 'gradeSource',
      width: 110,
      render: (_value, record) =>
        record.gradeManual ? <Tag color="purple">人工复核</Tag> : <Tag>自动判定</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 240,
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.tideStatus === 'suspended' || record.tideStatus === 'invalidated' ? (
            <Button
              size="small"
              type="link"
              onClick={async () => {
                await reviewSurvey(record.id, 'forced');
                message.success('已按涨潮硬凑照收，可正常定级');
              }}
            >
              硬凑照收
            </Button>
          ) : null}
          <Button
            size="small"
            type="link"
            icon={<EditOutlined />}
            disabled={isReadonly(record)}
            onClick={() => openEdit(record)}
          >
            {isReadonly(record) ? '只读' : '编辑'}
          </Button>
          <Popconfirm
            title="确认删除该测次记录？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await deleteSurvey(record.id);
              await remove(record.id);
              message.success('验收记录已删除');
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const warnPlots = plots.filter((plot) => {
    const stat = statOf(plot.id);
    return stat.surveyCount > 0 && stat.latestRate < SURVIVAL_WARN_RATE && statOf(plot.id).suggestReplant > 0;
  });

  const hungCount = rows.filter((row) => row.tideStatus === 'suspended' || row.tideStatus === 'invalidated').length;

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="验收记录" value={rows.length} suffix="条" tone="primary" icon={<ExperimentOutlined />} />
        <StatBadge label="已验收地块" value={stats.ratedCount} suffix="块" tone="info" />
        <StatBadge label="平均成活率" value={percentText(stats.avgRate)} percent={stats.avgRate} tone="success" />
        <StatBadge
          label="优秀地块占比"
          value={percentText(stats.strongPct)}
          percent={stats.strongPct}
          tone="primary"
          hint="最新成活率 ≥ 85% 的地块占比"
        />
        <StatBadge
          label="告警地块"
          value={stats.warnCount}
          suffix="块"
          tone={stats.warnCount > 0 ? 'danger' : 'default'}
          hint={`最新成活率低于 ${SURVIVAL_WARN_RATE}% 的地块`}
        />
        <StatBadge
          label="挂起/失效测次"
          value={hungCount}
          suffix="条"
          tone={hungCount > 0 ? 'warning' : 'default'}
          hint="停在露滩时段外待复核；挂起期间不生成补植计划"
        />
      </div>

      {warnPlots.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${warnPlots.length} 个地块的最新成活率低于 ${SURVIVAL_WARN_RATE}%`}
          description={
            <Space direction="vertical" size={2}>
              {warnPlots.map((plot) => (
                <span key={plot.id}>
                  {plot.name}：最新成活率 {percentText(statOf(plot.id).latestRate)}，建议补植{' '}
                  {statOf(plot.id).suggestReplant} 株
                </span>
              ))}
            </Space>
          }
        />
      ) : null}

      <Card
        title="成活率与株高验收台"
        extra={
          <Space>
            <Button icon={<ToolOutlined />} onClick={() => void handleGenerateReplant()}>
              生成补植计划
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()} disabled={plots.length === 0}>
              录入测次
            </Button>
          </Space>
        }
      >
        <Space size={12} wrap style={{ marginBottom: 14 }}>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>地块</span>
            <Select
              style={{ minWidth: 200 }}
              value={filters.plotId}
              onChange={(value: string) => setFilters({ plotId: value })}
              options={[
                { value: 'all', label: '全部地块' },
                ...plots.map((plot) => ({ value: plot.id, label: plot.name })),
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>等级</span>
            <Select
              style={{ minWidth: 140 }}
              value={filters.level}
              onChange={(value: string) => setFilters({ level: value as RateLevel | 'all' })}
              options={[
                { value: 'all', label: '全部等级' },
                ...RATE_LEVEL_OPTIONS.map((level) => ({ value: level, label: RATE_LEVEL_LABEL[level] })),
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>潮位对账</span>
            <Select
              style={{ minWidth: 150 }}
              value={filters.tideStatus}
              onChange={(value: string) => setFilters({ tideStatus: value as TideStatus | 'all' })}
              options={[
                { value: 'all', label: '全部状态' },
                ...TIDE_STATUS_FILTER_OPTIONS.map((status) => ({ value: status, label: TIDE_STATUS_LABEL[status] })),
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>日期区间</span>
            <DatePicker
              value={filters.from === '' ? null : dayjs(filters.from)}
              onChange={(value) => setFilters({ from: value === null ? '' : value.format('YYYY-MM-DD') })}
              placeholder="开始日期"
            />
            <DatePicker
              value={filters.to === '' ? null : dayjs(filters.to)}
              onChange={(value) => setFilters({ to: value === null ? '' : value.format('YYYY-MM-DD') })}
              placeholder="结束日期"
            />
          </Space>
          <Button onClick={resetFilters}>重置筛选</Button>
          <Tag color="cyan">
            命中 {filtered.length} / {rows.length} 条
          </Tag>
        </Space>

        <Space size={12} wrap style={{ marginBottom: 14 }}>
          <Tag color={selectedIds.length > 0 ? 'purple' : 'default'}>已选 {selectedIds.length} 条</Tag>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>批量调整为</span>
            <Select
              style={{ minWidth: 120 }}
              value={gradeDraft}
              onChange={(value: RateLevel) => setGradeDraft(value)}
              options={RATE_LEVEL_OPTIONS.map((level) => ({ value: level, label: RATE_LEVEL_LABEL[level] }))}
            />
          </Space>
          <Button type="primary" ghost disabled={selectedIds.length === 0} onClick={() => void handleBulkGrade()}>
            批量调整成活率等级
          </Button>
          <Button disabled={selectedIds.length === 0} onClick={() => setSelectedIds([])}>
            取消选择
          </Button>
        </Space>

        {rows.length === 0 && !loading ? (
          <EmptyPanel
            title="还没有任何验收记录"
            description="按测次录入成活株数与平均株高，系统会自动计算成活率并在低于阈值时告警。"
            actionText="录入第一个测次"
            onAction={openCreate}
          />
        ) : (
          <Table<Survey>
            rowKey="id"
            size="middle"
            loading={loading || !ready}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1560 }}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
            }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: (
                <EmptyPanel title="没有符合筛选条件的验收记录" actionText="重置筛选" onAction={resetFilters} />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '录入验收测次' : `编辑验收测次（${isReadonly(editing) ? '历史只读' : '可编辑'}）`}
        open={open}
        onCancel={() => {
          setOpen(false);
          setSearchParams({});
        }}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: isReadonly(editing) }}
      >
        {isReadonly(editing) ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="该历史测次补不上作业时刻来源，按升级规则只读留着，不能编辑或定级。"
          />
        ) : null}
        <Form form={form} layout="vertical" disabled={isReadonly(editing)}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="plotId" label="地块" style={{ flex: 2 }} rules={[{ required: true, message: '请选择地块' }]}>
              <Select options={plots.map((plot) => ({ value: plot.id, label: plot.name }))} />
            </Form.Item>
            <Form.Item name="round" label="测次" style={{ flex: 1 }} rules={[{ required: true, message: '请填写测次' }]}>
              <InputNumber min={1} max={99} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="end">
            <Form.Item name="date" label="验收日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="range"
              label="作业起止时刻"
              style={{ flex: 2 }}
              rules={[{ required: true, message: '请选择作业起止时刻' }]}
            >
              <TimePicker.RangePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          {formPreview?.plotId ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
              {(() => {
                const station = stationOfPlot(formPreview.plotId);
                if (!station) return '该地块尚未挂潮位站，无法对账：保存后先挂起，可在潮位对账页确认。';
                if (previewDayWindows.length === 0)
                  return `对账站「${station.name}」当天没有露滩时段记录；不勾硬凑将挂起等复核。`;
                const segText = previewDayWindows.map((w) => `${w.startAt}-${w.endAt}(v${w.version})`).join('、');
                if (previewFit === null) return `当天露滩时段：${segText}`;
                return previewFit
                  ? `作业落在露滩时段内（${segText}），按露滩有效入账并锁定 v${previewFit}。`
                  : `作业在露滩时段外（当天：${segText}）；勾「涨潮硬凑照收」则照收定级，否则先挂起等复核。`;
              })()}
            </Typography.Text>
          ) : null}
          <Form.Item name="forced" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>涨潮硬凑照收（作业在露滩时段外，但照常验收，仍计入成活率与定级）</Checkbox>
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="aliveCount"
              label="成活株数"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写成活株数' }]}
            >
              <InputNumber min={0} max={500000} step={10} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="avgHeightCm"
              label="平均株高（cm）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写平均株高' }]}
            >
              <InputNumber min={0} max={2000} step={1} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            成活率 = 成活株数 / 该地块栽植总株数，保存时自动计算；挂起 / 失效 / 只读测次先复核，挂起期间不生成补植计划。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
