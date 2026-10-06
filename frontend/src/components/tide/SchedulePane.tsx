/**
 * 外业排测次（排期）
 * - 选定潮位站与日期区间，勾选要下滩验收的地块（时长默认取地块配置，可临时改）
 * - 调 schedulePlots 纯函数贪心装箱：当前露滩段排不下就顺到下一段，全部段都排不下的地块挂起
 * - 只做排期推演并给出跳转录入入口，不直接改外业测次；挂起地块不生成补植计划
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Checkbox, DatePicker, Empty, InputNumber, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FieldTimeOutlined, PauseCircleOutlined, RightCircleOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import StatBadge from '../../components/common/StatBadge';
import { useIdbTable } from '../../hooks/useIdbTable';
import { usePlotStore } from '../../stores/plotStore';
import { db } from '../../utils/db';
import { ROUTES } from '../../router';
import type { Plot } from '../../types/plot';
import type { TideStation } from '../../types/tide';
import { durationOf, schedulePlots, type ScheduleItem } from '../../utils/tide';

export default function SchedulePane() {
  const navigate = useNavigate();
  const plots = usePlotStore((state) => state.plots);
  const { rows: stations } = useIdbTable<TideStation>(db.tideStations, { sortByUpdatedAt: false });
  const { rows: windows } = useIdbTable(db.tideWindows, { sortByUpdatedAt: false });

  const [stationId, setStationId] = useState<string>('');
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>([dayjs(), dayjs().add(7, 'day')]);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [result, setResult] = useState<ScheduleItem[] | null>(null);

  const selectedStationId = stationId || stations[0]?.id || '';
  const station = stations.find((item) => item.id === selectedStationId) ?? null;

  const stationPlots = useMemo(
    () =>
      plots
        .filter((plot) => plot.tideStationId === selectedStationId)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    [plots, selectedStationId],
  );

  const [checked, setChecked] = useState<string[]>([]);
  const effectiveChecked = checked.filter((id) => stationPlots.some((plot) => plot.id === id));

  const rangeWindows = useMemo(() => {
    if (!range) return [];
    const from = range[0].format('YYYY-MM-DD');
    const to = range[1].format('YYYY-MM-DD');
    return windows
      .filter((win) => win.stationId === selectedStationId && win.date >= from && win.date <= to)
      .sort((a, b) =>
        a.date.localeCompare(b.date) !== 0 ? a.date.localeCompare(b.date) : a.startAt.localeCompare(b.startAt),
      );
  }, [windows, selectedStationId, range]);

  const durationFor = (plot: Plot): number => durations[plot.id] ?? durationOf(plot);

  const runSchedule = (): void => {
    const jobs = effectiveChecked.map((id) => {
      const plot = stationPlots.find((item) => item.id === id);
      return { plotId: id, durationMin: plot ? durationFor(plot) : 90 };
    });
    setResult(schedulePlots(jobs, rangeWindows));
  };

  const resultById = useMemo(() => {
    const map = new Map<string, ScheduleItem>();
    result?.forEach((item) => map.set(item.plotId, item));
    return map;
  }, [result]);

  const suspendedCount = result?.filter((item) => item.suspended).length ?? 0;
  const rolloverCount = result?.filter((item) => !item.suspended && item.rollover > 0).length ?? 0;

  const columns: ColumnsType<Plot> = [
    {
      title: '地块',
      key: 'name',
      render: (_v, record) => (
        <Space direction="vertical" size={0}>
          <span>{record.name}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.areaMu} 亩 · {record.tideZone}潮位带
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '作业时长（分钟）',
      key: 'duration',
      width: 180,
      render: (_v, record) => (
        <InputNumber
          min={15}
          max={600}
          step={15}
          style={{ width: 140 }}
          value={durationFor(record)}
          onChange={(value) => setDurations((prev) => ({ ...prev, [record.id]: value ?? durationOf(record) }))}
        />
      ),
    },
    {
      title: '排期结果',
      key: 'result',
      render: (_v, record) => {
        const item = resultById.get(record.id);
        if (!item) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>未排期</Typography.Text>;
        if (item.suspended) {
          return (
            <Space size={6}>
              <Tag icon={<PauseCircleOutlined />} color="gold">挂起等复核</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>区间内所有段都排不下</Typography.Text>
            </Space>
          );
        }
        return (
          <Space size={6} wrap>
            <Tag color="green">{item.date}</Tag>
            <span>{item.startAt} ~ {item.endAt}</span>
            <Tag color="purple">v{item.version}</Tag>
            {item.rollover > 0 ? <Tag color="orange">顺移 {item.rollover} 段</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '下滩录入',
      key: 'go',
      width: 150,
      render: (_v, record) => {
        const item = resultById.get(record.id);
        if (!item || item.suspended) {
          return (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {item?.suspended ? '挂起，先复核' : '排期后可录入'}
            </Typography.Text>
          );
        }
        return (
          <Button
            size="small"
            type="link"
            icon={<RightCircleOutlined />}
            onClick={() => {
              usePlotStore.getState().selectPlot(record.id);
              navigate(`${ROUTES.surveys}?plotId=${record.id}&date=${item.date}&start=${item.startAt}&end=${item.endAt}`);
            }}
          >
            去验收台录入
          </Button>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="区间露滩段" value={rangeWindows.length} suffix="段" tone="info" icon={<FieldTimeOutlined />} />
        <StatBadge label="已排入" value={result ? result.length - suspendedCount : 0} suffix="块" tone="success" />
        <StatBadge label="顺到后段" value={rolloverCount} suffix="块" tone="warning" hint="当前段排不下、顺到了后面的露滩段" />
        <StatBadge label="挂起等复核" value={suspendedCount} suffix="块" tone={suspendedCount > 0 ? 'danger' : 'default'} hint="所有段都排不下；挂起期间不生成补植计划" />
      </div>

      <Space size={12} wrap style={{ marginBottom: 14 }}>
        <Space size={6}>
          <span style={{ color: '#5b6b66', fontSize: 13 }}>潮位站</span>
          <Select
            style={{ width: 240 }}
            value={selectedStationId || undefined}
            placeholder="选择潮位站"
            onChange={(value: string) => {
              setStationId(value);
              setChecked([]);
              setResult(null);
            }}
            options={stations.map((item) => ({ value: item.id, label: `${item.name}（${item.code} · v${item.tideTableVersion}）` }))}
          />
        </Space>
        <Space size={6}>
          <span style={{ color: '#5b6b66', fontSize: 13 }}>排期区间</span>
          <DatePicker.RangePicker
            value={range}
            allowClear={false}
            onChange={(value) => {
              setRange(value as [Dayjs, Dayjs] | null);
              setResult(null);
            }}
          />
        </Space>
        <Checkbox
          checked={effectiveChecked.length === stationPlots.length && stationPlots.length > 0}
          indeterminate={effectiveChecked.length > 0 && effectiveChecked.length < stationPlots.length}
          onChange={(event) => {
            setChecked(event.target.checked ? stationPlots.map((plot) => plot.id) : []);
            setResult(null);
          }}
        >
          全选该站地块
        </Checkbox>
        <Button type="primary" disabled={effectiveChecked.length === 0 || rangeWindows.length === 0} onClick={runSchedule}>
          按露滩段排期
        </Button>
      </Space>

      {rangeWindows.length === 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message="所选区间内该站没有露滩时段"
          description="请先在「潮位站与露滩时段」里维护区间内的时段，或调整排期区间。"
        />
      ) : null}
      {suspendedCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${suspendedCount} 块地在区间内所有露滩段都排不下，已挂起等复核`}
          description="挂起期间不会为这些地块生成补植计划；可放大区间或拆短作业时长后重排。"
        />
      ) : null}

      <Card size="small" title={station ? `外业按地块排测次 · ${station.name}` : '外业按地块排测次'}>
        {stationPlots.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={selectedStationId === '' ? '请先选择潮位站' : '还没有地块挂到该站，请先在地块台账或潮位站页挂站'}
          />
        ) : (
          <Table<Plot>
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={stationPlots}
            pagination={false}
            rowSelection={{
              selectedRowKeys: effectiveChecked,
              onChange: (keys) => {
                setChecked(keys.map((key) => String(key)));
                setResult(null);
              },
            }}
          />
        )}
      </Card>
    </div>
  );
}
