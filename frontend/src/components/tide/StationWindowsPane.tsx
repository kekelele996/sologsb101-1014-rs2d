/**
 * 潮位站与每天露滩时段维护
 * - 站点增删改、地块挂站（排期 / 对账按该站取当天时段）
 * - 选定站点 + 日期维护当天若干露滩段；保存即发布新版潮位表，未定级测次失效重算
 * - 潮位表 CSV 导入：坏行逐条列出，「只重试潮位侧」不会动外业排期
 */
import { useMemo, useState } from 'react';
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
  Tag,
  TimePicker,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../../components/common/EmptyPanel';
import StatBadge from '../../components/common/StatBadge';
import { useIdbTable } from '../../hooks/useIdbTable';
import { usePlotStore } from '../../stores/plotStore';
import { useTideStore } from '../../stores/tideStore';
import { db } from '../../utils/db';
import {
  TIDE_LEVEL_OPTIONS,
  TIDE_SOURCE_OPTIONS,
  type TideLevel,
  type TideSource,
  type TideStation,
} from '../../types/tide';
import { parseTideCsv } from '../../utils/tideImport';
import type { TideImportFailure } from '../../utils/db';

interface StationFormValues {
  code: string;
  name: string;
  level: TideLevel;
  note: string;
}

interface SegmentDraft {
  start: Dayjs;
  end: Dayjs;
  source: TideSource;
}

export default function StationWindowsPane() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const bindPlotStation = useTideStore((state) => state.bindPlotStation);
  const createStation = useTideStore((state) => state.createStation);
  const updateStation = useTideStore((state) => state.updateStation);
  const deleteStation = useTideStore((state) => state.deleteStation);
  const saveDayWindows = useTideStore((state) => state.saveDayWindows);
  const importTable = useTideStore((state) => state.importTable);
  const retryImport = useTideStore((state) => state.retryImport);
  const retryImportText = useTideStore((state) => state.retryImportText);
  const lastImport = useTideStore((state) => state.lastImport);

  const { rows: stations, loading } = useIdbTable<TideStation>(db.tideStations, { sortByUpdatedAt: false });
  const { rows: windows } = useIdbTable(db.tideWindows, { sortByUpdatedAt: false });

  const [stationOpen, setStationOpen] = useState(false);
  const [editingStation, setEditingStation] = useState<TideStation | null>(null);
  const [stationForm] = Form.useForm<StationFormValues>();

  const [activeId, setActiveId] = useState<string>('');
  const [dayOpen, setDayOpen] = useState(false);
  const [dayDate, setDayDate] = useState<Dayjs>(dayjs());
  const [segments, setSegments] = useState<SegmentDraft[]>([]);
  const [savingDay, setSavingDay] = useState(false);

  const selectedId = activeId || stations[0]?.id || '';
  const selectedStation = stations.find((item) => item.id === selectedId) ?? null;
  const stationWindows = useMemo(
    () => windows.filter((win) => win.stationId === selectedId),
    [windows, selectedId],
  );

  const boundPlots = plots.filter((plot) => plot.tideStationId === selectedId);

  const openCreateStation = (): void => {
    setEditingStation(null);
    stationForm.setFieldsValue({ code: '', name: '', level: '中', note: '人工维护' });
    setStationOpen(true);
  };

  const openEditStation = (station: TideStation): void => {
    setEditingStation(station);
    stationForm.setFieldsValue({ code: station.code, name: station.name, level: station.level, note: station.note });
    setStationOpen(true);
  };

  const handleStationSubmit = async (): Promise<void> => {
    try {
      const values = await stationForm.validateFields();
      if (editingStation === null) {
        const row = await createStation(values);
        message.success(`已新建潮位站「${row.name}」`);
      } else {
        await updateStation(editingStation.id, values);
        message.success('潮位站信息已更新');
      }
      setStationOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    }
  };

  const openDayEditor = (date: Dayjs): void => {
    const dateStr = date.format('YYYY-MM-DD');
    const existing = stationWindows.filter((win) => win.date === dateStr);
    setDayDate(date);
    setSegments(
      existing.length > 0
        ? existing.map((win) => ({
            start: dayjs(`${dateStr} ${win.startAt}`),
            end: dayjs(`${dateStr} ${win.endAt}`),
            source: win.source,
          }))
        : [{ start: dayjs(`${dateStr} 08:00`), end: dayjs(`${dateStr} 11:00`), source: '人工维护' }],
    );
    setDayOpen(true);
  };

  const handleSaveDay = async (): Promise<void> => {
    if (selectedStation === null) return;
    if (segments.length === 0) {
      message.warning('请至少保留一段露滩时段');
      return;
    }
    const payload = segments.map((seg) => ({
      startAt: seg.start.format('HH:mm'),
      endAt: seg.end.format('HH:mm'),
      source: seg.source,
    }));
    const invalid = payload.find((seg) => seg.startAt === 'Invalid Date' || seg.endAt === 'Invalid Date');
    if (invalid) {
      message.error('存在未填写完整的时刻');
      return;
    }
    try {
      setSavingDay(true);
      const dateStr = dayDate.format('YYYY-MM-DD');
      const version = await saveDayWindows(selectedStation.id, dateStr, payload);
      message.success(`已发布第 ${version} 版潮位表：${dateStr} 当天 ${payload.length} 段；未定级测次已按新版重算`);
      setDayOpen(false);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存露滩时段失败');
    } finally {
      setSavingDay(false);
    }
  };

  const handleImport = async (file: File): Promise<void> => {
    const text = await file.text();
    const parsed = parseTideCsv(text);
    if (parsed.rows.length === 0) {
      message.error(`潮位表没有可导入的行（${parsed.failures.length} 行格式错误），外业排期未受影响`);
      await importTable([], parsed.failures);
      return;
    }
    const result = await importTable(parsed.rows, parsed.failures);
    message.success(`潮位侧导入完成：${result.stationCount} 站 / ${result.windowCount} 段；坏行 ${result.failures.length} 条`);
  };

  const handleRetryFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const result = await retryImportText(text);
    message.success(`潮位侧重试完成：导入 ${result.windowCount} 段，仍有坏行 ${result.failures.length} 条；外业排期未受影响`);
  };

  const stationColumns: ColumnsType<TideStation> = [
    { title: '站点编码', dataIndex: 'code', key: 'code', width: 120, render: (value: string) => <Tag color="geekblue">{value}</Tag> },
    { title: '站点名', dataIndex: 'name', key: 'name' },
    { title: '潮位带', dataIndex: 'level', key: 'level', width: 90, render: (value: TideLevel) => <Tag color="cyan">{value}</Tag> },
    {
      title: '潮位表版本',
      dataIndex: 'tideTableVersion',
      key: 'tideTableVersion',
      width: 110,
      align: 'center',
      render: (value: number) => <Tag color="purple">v{value}</Tag>,
    },
    {
      title: '说明',
      dataIndex: 'note',
      key: 'note',
      width: 240,
      render: (value: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{value}</Typography.Text>,
    },
    {
      title: '操作',
      key: 'action',
      width: 210,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => { setActiveId(record.id); openDayEditor(dayjs()); }}>
            维护当天时段
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditStation(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该潮位站会同时删掉其露滩时段，并解绑地块"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await deleteStation(record.id);
              message.success('潮位站已删除，外业测次保留');
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

  const windowColumns: ColumnsType<(typeof windows)[number]> = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 130, sorter: (a, b) => a.date.localeCompare(b.date) },
    { title: '露滩开始', dataIndex: 'startAt', key: 'startAt', width: 100 },
    { title: '露滩结束', dataIndex: 'endAt', key: 'endAt', width: 100 },
    { title: '版本', dataIndex: 'version', key: 'version', width: 80, align: 'center', render: (v: number) => <Tag>v{v}</Tag> },
    { title: '来源', dataIndex: 'source', key: 'source', width: 120, render: (v: TideSource) => <Tag color={v === '潮位表导入' ? 'blue' : 'default'}>{v}</Tag> },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="潮位监测站" value={stations.length} suffix="个" tone="primary" />
        <StatBadge label="露滩时段" value={windows.length} suffix="段" tone="info" />
        <StatBadge label="当前站挂地块" value={boundPlots.length} suffix="块" tone="success" />
      </div>

      <Card
        size="small"
        title="潮位监测站"
        style={{ marginBottom: 14 }}
        extra={
          <Space wrap>
            <Upload
              accept=".csv"
              showUploadList={false}
              beforeUpload={(file) => {
                void handleImport(file as unknown as File);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />}>导入潮位表 CSV</Button>
            </Upload>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateStation}>
              新建潮位站
            </Button>
          </Space>
        }
      >
        {stations.length === 0 && !loading ? (
          <EmptyPanel
            title="还没有潮位监测站"
            description="潮位监测站按站点维护每天的露滩时段；先建站点，再把地块挂到对应站点，才能在排期前对账。"
            actionText="新建第一个潮位站"
            onAction={openCreateStation}
          />
        ) : (
          <Table<TideStation>
            rowKey="id"
            size="small"
            loading={loading}
            columns={stationColumns}
            dataSource={stations}
            pagination={false}
            onRow={(record) => ({ onClick: () => setActiveId(record.id) })}
            rowClassName={(record) => (record.id === selectedId ? 'ant-table-row-selected' : '')}
          />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          CSV 列：站点编码, 站点名称, 潮位带(低/中/高), 日期(YYYY-MM-DD), 露滩开始(HH:mm), 露滩结束(HH:mm)。
          导入失败只重试潮位侧，外业排期照旧。
        </Typography.Text>
      </Card>

      {lastImport && lastImport.failures.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`潮位表有 ${lastImport.failures.length} 行未导入（只影响潮位侧）`}
          description={
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {lastImport.failures.slice(0, 6).map((fail: TideImportFailure, idx) => (
                <Typography.Text key={idx} style={{ fontSize: 12 }}>
                  第 {fail.line} 行：{fail.reason}
                </Typography.Text>
              ))}
              <Space>
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={async () => {
                    const result = await retryImport();
                    if (result) message.success(`潮位侧重试完成，剩余坏行 ${result.failures.length} 条`);
                  }}
                >
                  只重试潮位侧
                </Button>
                <Upload
                  accept=".csv"
                  showUploadList={false}
                  beforeUpload={(file) => {
                    void handleRetryFile(file as unknown as File);
                    return false;
                  }}
                >
                  <Button size="small" icon={<UploadOutlined />}>
                    重新上传修正表重试
                  </Button>
                </Upload>
              </Space>
            </Space>
          }
        />
      ) : null}

      {selectedStation !== null ? (
        <Card
          size="small"
          title={
            <Space wrap>
              <span>{selectedStation.name}（{selectedStation.code}）露滩时段</span>
              <Tag color="purple">当前 v{selectedStation.tideTableVersion}</Tag>
            </Space>
          }
          extra={
            <Space>
              <DatePicker
                value={dayDate}
                allowClear={false}
                onChange={(value) => value && setDayDate(value)}
              />
              <Button type="primary" ghost onClick={() => openDayEditor(dayDate)}>
                维护 {dayDate.format('MM-DD')} 当天时段
              </Button>
            </Space>
          }
        >
          <Space wrap style={{ marginBottom: 10 }}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>挂在该站的地块：</span>
            {boundPlots.length === 0 ? <Tag>暂无地块挂站</Tag> : null}
            {boundPlots.map((plot) => (
              <Tag key={plot.id} color="geekblue" closable onClose={(event) => {
                event.preventDefault();
                void bindPlotStation(plot.id, '').then(() => message.success(`地块「${plot.name}」已解绑`));
              }}>
                {plot.name}
              </Tag>
            ))}
            <Select
              size="small"
              style={{ width: 280 }}
              placeholder="把未挂站的地块挂到该站"
              value={undefined}
              onChange={async (plotId: string) => {
                if (!plotId) return;
                await bindPlotStation(plotId, selectedStation.id);
                const plot = plots.find((item) => item.id === plotId);
                message.success(`地块「${plot?.name ?? ''}」已挂到${selectedStation.name}`);
              }}
              options={plots
                .filter((plot) => plot.tideStationId !== selectedStation.id)
                .map((plot) => ({
                  value: plot.id,
                  label: plot.tideStationId === '' ? `${plot.name}（未挂站）` : `${plot.name}（已挂他站）`,
                }))}
            />
          </Space>
          <Table
            rowKey="id"
            size="small"
            columns={windowColumns}
            dataSource={stationWindows}
            pagination={{ pageSize: 6, showSizeChanger: false }}
            locale={{ emptyText: '该站尚未维护露滩时段' }}
          />
        </Card>
      ) : null}

      <Modal
        title={editingStation === null ? '新建潮位监测站' : `编辑潮位站 · ${editingStation.name}`}
        open={stationOpen}
        onCancel={() => setStationOpen(false)}
        onOk={() => void handleStationSubmit()}
        okText="保存"
        cancelText="取消"
      >
        <Form form={stationForm} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="code" label="站点编码" style={{ flex: 1 }} rules={[{ required: true, message: '请填写站点编码' }]}>
              <Input placeholder="如 DG-01" />
            </Form.Item>
            <Form.Item name="level" label="潮位带" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={TIDE_LEVEL_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
          </Space>
          <Form.Item name="name" label="站点名" rules={[{ required: true, message: '请填写站点名' }]}>
            <Input placeholder="如 东港南堤潮位站" />
          </Form.Item>
          <Form.Item name="note" label="维护说明">
            <Input placeholder="如 人工维护 / 潮位表导入" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`维护露滩时段 · ${selectedStation?.name ?? ''} · ${dayDate.format('YYYY-MM-DD')}`}
        open={dayOpen}
        onCancel={() => setDayOpen(false)}
        onOk={() => void handleSaveDay()}
        confirmLoading={savingDay}
        okText="发布新版并重算"
        cancelText="取消"
        width={620}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="保存即把当天时段整体覆盖为新版本：未定级测次对不上新时段会失效重算；已定级测次留原值并标注依据的版本。"
        />
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {segments.map((seg, index) => (
            <Space key={index} size={8} align="center">
              <TimePicker
                value={seg.start}
                format="HH:mm"
                minuteStep={5}
                allowClear={false}
                onChange={(value) => {
                  if (!value) return;
                  setSegments((prev) => prev.map((item, i) => (i === index ? { ...item, start: value } : item)));
                }}
              />
              <span>~</span>
              <TimePicker
                value={seg.end}
                format="HH:mm"
                minuteStep={5}
                allowClear={false}
                onChange={(value) => {
                  if (!value) return;
                  setSegments((prev) => prev.map((item, i) => (i === index ? { ...item, end: value } : item)));
                }}
              />
              <Select
                size="middle"
                style={{ width: 130 }}
                value={seg.source}
                onChange={(value: TideSource) =>
                  setSegments((prev) => prev.map((item, i) => (i === index ? { ...item, source: value } : item)))
                }
                options={TIDE_SOURCE_OPTIONS.map((value) => ({ value, label: value }))}
              />
              <Button
                danger
                size="small"
                disabled={segments.length === 1}
                onClick={() => setSegments((prev) => prev.filter((_item, i) => i !== index))}
              >
                删除
              </Button>
            </Space>
          ))}
          <Button
            icon={<PlusOutlined />}
            onClick={() =>
              setSegments((prev) => [
                ...prev,
                {
                  start: dayjs(`${dayDate.format('YYYY-MM-DD')} 13:00`),
                  end: dayjs(`${dayDate.format('YYYY-MM-DD')} 15:30`),
                  source: '人工维护',
                },
              ])
            }
          >
            增加一段
          </Button>
        </Space>
      </Modal>
    </div>
  );
}
