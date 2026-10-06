/**
 * /tide 露滩时段与排期对账台
 * - 潮位站按站点维护每天露滩时段（改动后版本 +1）
 * - 潮位表导入失败只重试潮位侧，外业排期照旧
 * - 测次按地块 + 日期对账：落进时段算数，停在时段外挂起等复核，补不上来源只读留着
 * - 一段排不下顺到下一段；挂起期间不生成补植计划
 * 消费模型：TideStation、TideWindow、TideImport、TideSource、Survey、Plot；
 * 复用组件：<StatBadge>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  TimePicker,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  ForwardOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  RedoOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useTideStore } from '../stores/tideStore';
import { usePlotStore } from '../stores/plotStore';
import { useIdbTable } from '../hooks/useIdbTable';
import { db } from '../utils/db';
import {
  TIDE_CHECK_STATUS_COLOR,
  TIDE_CHECK_STATUS_LABEL,
  type TideCheckStatus,
  type TideImport,
  type TideStation,
  type TideWindow,
} from '../types/tide';
import type { Survey } from '../types/survey';
import { windowText } from '../utils/tide';

interface WindowFormValues {
  stationId: string;
  date: Dayjs;
  startTime: Dayjs;
  endTime: Dayjs;
}

interface StationFormValues {
  name: string;
  code: string;
  location: string;
}

export default function TideSchedule() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const { rows: surveyRows } = useIdbTable<Survey>(db.surveys, { sortByUpdatedAt: false });

  const stations = useTideStore((state) => state.stations);
  const windows = useTideStore((state) => state.windows);
  const imports = useTideStore((state) => state.imports);
  const sources = useTideStore((state) => state.sources);
  const loading = useTideStore((state) => state.loading);
  const ready = useTideStore((state) => state.ready);
  const loadAll = useTideStore((state) => state.loadAll);
  const createStation = useTideStore((state) => state.createStation);
  const updateStation = useTideStore((state) => state.updateStation);
  const deleteStation = useTideStore((state) => state.deleteStation);
  const saveWindow = useTideStore((state) => state.saveWindow);
  const deleteWindow = useTideStore((state) => state.deleteWindow);
  const scheduleNextWindow = useTideStore((state) => state.scheduleNextWindow);
  const reviewSuspended = useTideStore((state) => state.reviewSuspended);
  const importTideTable = useTideStore((state) => state.importTideTable);
  const retryImport = useTideStore((state) => state.retryImport);
  const tideRevision = useTideStore((state) => state.revision);

  const [stationFilter, setStationFilter] = useState<string>('all');
  const [windowOpen, setWindowOpen] = useState(false);
  const [editingWindow, setEditingWindow] = useState<TideWindow | null>(null);
  const [stationOpen, setStationOpen] = useState(false);
  const [editingStation, setEditingStation] = useState<TideStation | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [windowForm] = Form.useForm<WindowFormValues>();
  const [stationForm] = Form.useForm<StationFormValues>();

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const filteredWindows = useMemo(() => {
    void tideRevision;
    return windows
      .filter((w) => (stationFilter === 'all' ? true : w.stationId === stationFilter))
      .sort((a, b) => a.stationId.localeCompare(b.stationId) || a.date.localeCompare(b.date));
  }, [windows, stationFilter, tideRevision]);

  const reconcileRows = useMemo(() => {
    void tideRevision;
    return surveyRows
      .map((survey) => {
        const plot = plots.find((p) => p.id === survey.plotId);
        const stationId = plot?.tideStationId ?? '';
        const source = sources.find((s) => s.surveyId === survey.id);
        const win = source ? windows.find((w) => w.id === source.windowId) : undefined;
        return { survey, plot, stationId, source, win };
      })
      .sort((a, b) => b.survey.date.localeCompare(a.survey.date) || a.survey.round - b.survey.round);
  }, [surveyRows, plots, sources, windows, tideRevision]);

  const suspendedCount = reconcileRows.filter((r) => r.survey.tideStatus === 'suspended').length;
  const readonlyCount = reconcileRows.filter((r) => r.survey.tideStatus === 'readonly').length;
  const normalCount = reconcileRows.filter((r) => r.survey.tideStatus === 'normal').length;

  const openWindowCreate = (): void => {
    setEditingWindow(null);
    windowForm.setFieldsValue({
      stationId: stationFilter !== 'all' ? stationFilter : stations[0]?.id ?? '',
      date: dayjs(),
      startTime: dayjs('07:00', 'HH:mm'),
      endTime: dayjs('10:00', 'HH:mm'),
    });
    setWindowOpen(true);
  };

  const openWindowEdit = (win: TideWindow): void => {
    setEditingWindow(win);
    windowForm.setFieldsValue({
      stationId: win.stationId,
      date: dayjs(win.date),
      startTime: dayjs(win.startTime, 'HH:mm'),
      endTime: dayjs(win.endTime, 'HH:mm'),
    });
    setWindowOpen(true);
  };

  const handleWindowSubmit = async (): Promise<void> => {
    try {
      const values = await windowForm.validateFields();
      setSubmitting(true);
      const draft = {
        stationId: values.stationId,
        date: values.date.format('YYYY-MM-DD'),
        startTime: values.startTime.format('HH:mm'),
        endTime: values.endTime.format('HH:mm'),
      };
      const { changed } = await saveWindow(draft, editingWindow?.id);
      message.success(changed ? '露滩时段已更新，未复核测次已重算' : '露滩时段已保存');
      setWindowOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const openStationCreate = (): void => {
    setEditingStation(null);
    stationForm.setFieldsValue({ name: '', code: '', location: '' });
    setStationOpen(true);
  };

  const openStationEdit = (station: TideStation): void => {
    setEditingStation(station);
    stationForm.setFieldsValue({ name: station.name, code: station.code, location: station.location });
    setStationOpen(true);
  };

  const handleStationSubmit = async (): Promise<void> => {
    try {
      const values = await stationForm.validateFields();
      setSubmitting(true);
      if (editingStation === null) {
        await createStation(values);
        message.success('潮位站已建立');
      } else {
        await updateStation(editingStation.id, values);
        message.success('潮位站已更新');
      }
      setStationOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleImport = async (): Promise<void> => {
    try {
      const parsed = JSON.parse(importText) as { rows?: Array<Record<string, unknown>> };
      const rows = (parsed.rows ?? []).map((r) => ({
        stationId: String(r.stationId ?? ''),
        date: String(r.date ?? ''),
        startTime: String(r.startTime ?? ''),
        endTime: String(r.endTime ?? ''),
      }));
      const record = await importTideTable('导入的潮位表.json', rows);
      if (record.status === 'failed') {
        message.error('潮位表导入失败：未解析到有效行，可在下方「导入批次」只重试潮位侧');
      } else {
        message.success(`潮位表导入成功：${record.rowCount} 条时段`);
        setImportOpen(false);
      }
    } catch {
      // 解析失败也落一条失败批次（只影响潮位侧，外业排期照旧）
      const record = await importTideTable('导入的潮位表.json', []);
      message.error(`潮位表导入失败：${record.error}`);
    }
  };

  const windowColumns: ColumnsType<TideWindow> = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 120, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '露滩时段',
      key: 'span',
      width: 160,
      render: (_v, record) => (
        <Tag icon={<ClockCircleOutlined />} color="blue">
          {record.startTime}–{record.endTime}
        </Tag>
      ),
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 90,
      render: (v: number) => <Tag>v{v}</Tag>,
    },
    {
      title: '来源',
      dataIndex: 'sourceId',
      key: 'sourceId',
      width: 160,
      render: (v: string) => (v === 'manual' ? '手工录入' : `导入批次 ${v.slice(-6)}`),
    },
    {
      title: '操作',
      key: 'action',
      width: 140,
      render: (_v, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openWindowEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该露滩时段？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void deleteWindow(record.id)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const reconcileColumns: ColumnsType<(typeof reconcileRows)[number]> = [
    {
      title: '地块',
      key: 'plot',
      width: 200,
      render: (_v, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.plot?.name ?? '（地块已删除）'}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.plot ? `${row.plot.tideZone}潮位带 / ${row.plot.substrate}` : ''}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '测次', dataIndex: ['survey', 'round'], key: 'round', width: 80, align: 'center', render: (v: number) => <Tag color="blue">第 {v} 次</Tag> },
    { title: '验收日期', dataIndex: ['survey', 'date'], key: 'date', width: 120 },
    {
      title: '作业时刻',
      key: 'work',
      width: 150,
      render: (_v, row) =>
        row.survey.workStartTime ? (
          <Tag icon={<ClockCircleOutlined />}>{row.survey.workStartTime}–{row.survey.workEndTime}</Tag>
        ) : (
          <Typography.Text type="secondary">无（历史数据）</Typography.Text>
        ),
    },
    {
      title: '露滩时段',
      key: 'window',
      width: 150,
      render: (_v, row) => windowText(row.win),
    },
    {
      title: '核对状态',
      key: 'status',
      width: 100,
      render: (_v, row) => (
        <Tag color={TIDE_CHECK_STATUS_COLOR[row.survey.tideStatus as TideCheckStatus]}>
          {TIDE_CHECK_STATUS_LABEL[row.survey.tideStatus as TideCheckStatus]}
        </Tag>
      ),
    },
    {
      title: '依据版本',
      key: 'version',
      width: 100,
      render: (_v, row) =>
        row.survey.tideWindowVersionId > 0 ? <Tag>v{row.survey.tideWindowVersionId}</Tag> : '—',
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_v, row) => (
        <Space size={4}>
          {row.survey.tideStatus === 'suspended' ? (
            <>
              <Button
                size="small"
                type="link"
                icon={<ForwardOutlined />}
                onClick={async () => {
                  const moved = await scheduleNextWindow(row.survey.id);
                  if (moved) message.success(`已顺排到 ${moved.date}`);
                }}
              >
                顺到下一段
              </Button>
              <Button
                size="small"
                type="link"
                icon={<CheckCircleOutlined />}
                onClick={async () => {
                  await reviewSuspended(row.survey.id);
                  message.success('挂起测次已复核通过');
                }}
              >
                复核通过
              </Button>
            </>
          ) : null}
          {row.survey.tideStatus === 'readonly' ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              只读留着
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
  ];

  const importColumns: ColumnsType<TideImport> = [
    { title: '文件名', dataIndex: 'fileName', key: 'fileName' },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_v, record) => (
        <Tag color={record.status === 'success' ? 'green' : 'red'}>
          {record.status === 'success' ? '成功' : '失败'}
        </Tag>
      ),
    },
    { title: '行数', dataIndex: 'rowCount', key: 'rowCount', width: 80 },
    { title: '失败原因', dataIndex: 'error', key: 'error', render: (v: string) => v || '—' },
    { title: '导入时间', dataIndex: 'importedAt', key: 'importedAt', width: 180, render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
    {
      title: '操作',
      key: 'action',
      width: 140,
      render: (_v, record) =>
        record.status === 'failed' ? (
          <Popconfirm
            title="只重试潮位侧？外业排期不受影响、照旧进行"
            okText="重试潮位侧"
            cancelText="取消"
            onConfirm={async () => {
              await retryImport(record.id);
              message.success('潮位侧重试成功');
            }}
          >
            <Button size="small" type="link" icon={<RedoOutlined />}>
              重试潮位侧
            </Button>
          </Popconfirm>
        ) : (
          <Tag icon={<CheckCircleOutlined />} color="green">
            已完成
          </Tag>
        ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="潮位站" value={stations.length} suffix="个" tone="primary" />
        <StatBadge label="露滩时段" value={windows.length} suffix="条" tone="info" />
        <StatBadge label="正常测次" value={normalCount} suffix="条" tone="success" icon={<CheckCircleOutlined />} />
        <StatBadge label="挂起测次" value={suspendedCount} suffix="条" tone={suspendedCount > 0 ? 'danger' : 'default'} icon={<PauseCircleOutlined />} />
        <StatBadge label="只读测次" value={readonlyCount} suffix="条" tone="default" />
      </div>

      {suspendedCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${suspendedCount} 个测次停在露滩时段外（挂起等复核）`}
          description="挂起期间不生成补植计划。可「顺到下一段」排到后续露滩时段，或复核通过转为正常。"
        />
      ) : null}

      <Card
        title="露滩时段与排期对账"
        extra={
          <Space>
            <Button icon={<CloudUploadOutlined />} onClick={() => setImportOpen(true)}>
              导入潮位表
            </Button>
            <Button icon={<PlusOutlined />} onClick={openStationCreate}>
              新建潮位站
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openWindowCreate} disabled={stations.length === 0}>
              录入露滩时段
            </Button>
          </Space>
        }
      >
        <Tabs
          items={[
            {
              key: 'windows',
              label: `露滩时段（${filteredWindows.length}）`,
              children: (
                <>
                  <Space size={12} wrap style={{ marginBottom: 14 }}>
                    <Space size={6}>
                      <span style={{ color: '#5b6b66', fontSize: 13 }}>潮位站</span>
                      <Select
                        style={{ minWidth: 200 }}
                        value={stationFilter}
                        onChange={setStationFilter}
                        options={[
                          { value: 'all', label: '全部站点' },
                          ...stations.map((s) => ({ value: s.id, label: s.name })),
                        ]}
                      />
                    </Space>
                    <Button icon={<ReloadOutlined />} onClick={() => void loadAll()}>
                      刷新
                    </Button>
                  </Space>
                  {filteredWindows.length === 0 && !loading ? (
                    <EmptyPanel
                      title="还没有露滩时段"
                      description="按站点录入每天的露滩时段，测次才能按地块 + 日期对账。"
                      actionText="录入第一个时段"
                      onAction={openWindowCreate}
                    />
                  ) : (
                    <Table<TideWindow>
                      rowKey="id"
                      size="middle"
                      loading={loading || !ready}
                      columns={windowColumns}
                      dataSource={filteredWindows}
                      pagination={{ pageSize: 8, showSizeChanger: false }}
                    />
                  )}
                </>
              ),
            },
            {
              key: 'reconcile',
              label: `对账排期（${reconcileRows.length}）`,
              children: (
                <Table
                  rowKey={(row) => row.survey.id}
                  size="middle"
                  loading={loading || !ready}
                  columns={reconcileColumns}
                  dataSource={reconcileRows}
                  pagination={{ pageSize: 8, showSizeChanger: false }}
                />
              ),
            },
            {
              key: 'imports',
              label: `导入批次（${imports.length}）`,
              children: (
                <Table<TideImport>
                  rowKey="id"
                  size="middle"
                  loading={loading || !ready}
                  columns={importColumns}
                  dataSource={imports}
                  pagination={{ pageSize: 8, showSizeChanger: false }}
                />
              ),
            },
            {
              key: 'stations',
              label: `潮位站（${stations.length}）`,
              children: (
                <Table<TideStation>
                  rowKey="id"
                  size="middle"
                  loading={loading || !ready}
                  dataSource={stations}
                  pagination={false}
                  columns={[
                    { title: '站名', dataIndex: 'name', key: 'name' },
                    { title: '编码', dataIndex: 'code', key: 'code', width: 140 },
                    { title: '站址', dataIndex: 'location', key: 'location' },
                    {
                      title: '操作',
                      key: 'action',
                      width: 140,
                      render: (_v, record) => (
                        <Space size={4}>
                          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openStationEdit(record)}>
                            编辑
                          </Button>
                          <Popconfirm
                            title="确认删除该潮位站？其下时段与对账来源会一并清理"
                            okText="删除"
                            okButtonProps={{ danger: true }}
                            cancelText="取消"
                            onConfirm={() => void deleteStation(record.id)}
                          >
                            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                              删除
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={editingWindow === null ? '录入露滩时段' : '编辑露滩时段'}
        open={windowOpen}
        onCancel={() => setWindowOpen(false)}
        onOk={() => void handleWindowSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={windowForm} layout="vertical">
          <Form.Item name="stationId" label="潮位站" rules={[{ required: true, message: '请选择潮位站' }]}>
            <Select options={stations.map((s) => ({ value: s.id, label: s.name }))} />
          </Form.Item>
          <Form.Item name="date" label="露滩日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="startTime" label="开始时刻" style={{ flex: 1 }} rules={[{ required: true }]}>
              <TimePicker format="HH:mm" style={{ width: '100%' }} minuteStep={15} />
            </Form.Item>
            <Form.Item name="endTime" label="结束时刻" style={{ flex: 1 }} rules={[{ required: true }]}>
              <TimePicker format="HH:mm" style={{ width: '100%' }} minuteStep={15} />
            </Form.Item>
          </Space>
          {editingWindow !== null ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              改动当天时段后版本号 +1：没定级测次失效重算，已定级测次留原值并标依据哪一版。
            </Typography.Text>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title={editingStation === null ? '新建潮位站' : '编辑潮位站'}
        open={stationOpen}
        onCancel={() => setStationOpen(false)}
        onOk={() => void handleStationSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={stationForm} layout="vertical">
          <Form.Item name="name" label="站名" rules={[{ required: true, message: '请填写站名' }]}>
            <Input placeholder="如：东港潮位站" />
          </Form.Item>
          <Form.Item name="code" label="站点编码">
            <Input placeholder="如：DONGGANG" />
          </Form.Item>
          <Form.Item name="location" label="站址">
            <Input placeholder="如：东港南堤 3 号地块外侧滩涂" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="导入潮位表"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => void handleImport()}
        okText="导入"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          粘贴潮位表 JSON（含 rows 数组，每行 stationId / date / startTime / endTime）。
          导入失败只重试潮位侧，外业排期照旧进行、不受影响。
        </Typography.Paragraph>
        <Input.TextArea
          rows={8}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={'{\n  "rows": [\n    { "stationId": "tide-station-donggang", "date": "2025-04-01", "startTime": "07:00", "endTime": "10:00" }\n  ]\n}'}
        />
      </Modal>
    </div>
  );
}
