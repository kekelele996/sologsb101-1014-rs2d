/**
 * 排期前对账：按 地块 + 日期 把外业测次的作业起止与潮位站「当天露滩时段」对一遍。
 * - 选定站点与日期：上半区列当天露滩段，下半区列挂在该站地块当天的测次
 * - 落在时段内＝露滩有效；时段外未确认＝挂起，可在此「确认硬凑照收 / 改时段后重核」
 * - 挂起、失效、只读测次不计入成活统计，挂起期间不生成补植计划
 */
import { useMemo, useState } from 'react';
import { Alert, App, Button, Card, DatePicker, Empty, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import StatBadge from '../../components/common/StatBadge';
import TideStatusTag from '../../components/common/TideStatusTag';
import { useIdbTable } from '../../hooks/useIdbTable';
import { usePlotStore } from '../../stores/plotStore';
import { useSurveyStore } from '../../stores/surveyStore';
import { db } from '../../utils/db';
import type { Survey } from '../../types/survey';
import type { TideStation, TideWindow } from '../../types/tide';
import { fitsWindow, isEffectiveStatus } from '../../utils/tide';

export default function ReconcilePane() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const { rows: stations } = useIdbTable<TideStation>(db.tideStations, { sortByUpdatedAt: false });
  const { rows: allWindows } = useIdbTable<TideWindow>(db.tideWindows, { sortByUpdatedAt: false });
  const { rows: surveys, loading } = useIdbTable<Survey>(db.surveys, { sortByUpdatedAt: false });
  const reviewSurvey = useSurveyStore((state) => state.reviewSurvey);

  const [stationId, setStationId] = useState<string>('');
  const [date, setDate] = useState<Dayjs>(dayjs());

  const selectedStationId = stationId || stations[0]?.id || '';
  const dateStr = date.format('YYYY-MM-DD');

  const dayWindows = useMemo(
    () =>
      allWindows
        .filter((win) => win.stationId === selectedStationId && win.date === dateStr)
        .sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [allWindows, selectedStationId, dateStr],
  );

  const stationPlotIds = useMemo(
    () => plots.filter((plot) => plot.tideStationId === selectedStationId).map((plot) => plot.id),
    [plots, selectedStationId],
  );

  const daySurveys = useMemo(
    () =>
      surveys.filter(
        (survey) => stationPlotIds.includes(survey.plotId) && survey.date === dateStr,
      ),
    [surveys, stationPlotIds, dateStr],
  );

  const stats = useMemo(
    () => ({
      windows: dayWindows.length,
      effective: daySurveys.filter((row) => isEffectiveStatus(row.tideStatus)).length,
      hung: daySurveys.filter((row) => row.tideStatus === 'suspended' || row.tideStatus === 'invalidated').length,
    }),
    [dayWindows, daySurveys],
  );

  const plotName = (plotId: string): string => plots.find((plot) => plot.id === plotId)?.name ?? '（地块已删除）';

  const windowColumns: ColumnsType<TideWindow> = [
    { title: '露滩开始', dataIndex: 'startAt', key: 'startAt', width: 120 },
    { title: '露滩结束', dataIndex: 'endAt', key: 'endAt', width: 120 },
    { title: '版本', dataIndex: 'version', key: 'version', width: 90, align: 'center', render: (v: number) => <Tag color="purple">v{v}</Tag> },
    { title: '来源', dataIndex: 'source', key: 'source', render: (v: string) => <Tag color={v === '潮位表导入' ? 'blue' : 'default'}>{v}</Tag> },
  ];

  const surveyColumns: ColumnsType<Survey> = [
    { title: '地块', key: 'plot', width: 200, render: (_v, record) => plotName(record.plotId) },
    { title: '测次', dataIndex: 'round', key: 'round', width: 80, align: 'center', render: (v: number) => <Tag color="blue">第 {v} 次</Tag> },
    {
      title: '作业起止',
      key: 'times',
      width: 150,
      render: (_v, record) =>
        record.startAt && record.endAt ? (
          <span>{record.startAt} ~ {record.endAt}</span>
        ) : (
          <Typography.Text type="warning">无作业时刻（历史只读）</Typography.Text>
        ),
    },
    {
      title: '是否落进露滩段',
      key: 'fit',
      width: 130,
      render: (_v, record) => {
        if (!record.startAt || !record.endAt) return <Tag>无时刻</Tag>;
        const fit = dayWindows.some((win) => fitsWindow(record.startAt, record.endAt, win));
        return fit ? <Tag icon={<CheckCircleOutlined />} color="success">在时段内</Tag> : <Tag icon={<WarningOutlined />} color="error">时段外</Tag>;
      },
    },
    {
      title: '对账状态',
      key: 'status',
      width: 200,
      render: (_v, record) => <TideStatusTag status={record.tideStatus} basisVersion={record.tideBasisVersion} />,
    },
    {
      title: '成活株数 / 等级',
      key: 'alive',
      width: 150,
      render: (_v, record) => (
        <Space size={6}>
          <span>{record.aliveCount.toLocaleString('zh-CN')}</span>
          <Tag color={record.gradeManual ? 'purple' : 'default'}>{record.gradeManual ? '已定级' : '未定级'}</Tag>
        </Space>
      ),
    },
    {
      title: '复核',
      key: 'review',
      render: (_v, record) =>
        record.tideStatus === 'suspended' || record.tideStatus === 'invalidated' ? (
          <Space size={4}>
            <Button
              size="small"
              type="link"
              onClick={async () => {
                await reviewSurvey(record.id, 'forced');
                message.success('已按涨潮硬凑照收，该测次可正常定级');
              }}
            >
              硬凑照收
            </Button>
            <Button
              size="small"
              type="link"
              disabled={dayWindows.length === 0}
              onClick={async () => {
                await reviewSurvey(record.id, 'exposed');
                message.success('已解除挂起（如作业时刻仍不符，请在验收台改时刻后重核）');
              }}
            >
              改时段重核
            </Button>
          </Space>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>无需处理</Typography.Text>
        ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="当天露滩段" value={stats.windows} suffix="段" tone="info" />
        <StatBadge label="对账有效测次" value={stats.effective} suffix="条" tone="success" />
        <StatBadge label="挂起 / 失效" value={stats.hung} suffix="条" tone={stats.hung > 0 ? 'warning' : 'default'} hint="挂起期间不生成补植计划" />
      </div>

      <Space size={12} wrap style={{ marginBottom: 14 }}>
        <Space size={6}>
          <span style={{ color: '#5b6b66', fontSize: 13 }}>潮位站</span>
          <Select
            style={{ minWidth: 220 }}
            value={selectedStationId || undefined}
            placeholder="选择潮位站"
            onChange={(value: string) => setStationId(value)}
            options={stations.map((station) => ({ value: station.id, label: `${station.name}（${station.code} · v${station.tideTableVersion}）` }))}
          />
        </Space>
        <Space size={6}>
          <span style={{ color: '#5b6b66', fontSize: 13 }}>对账日期</span>
          <DatePicker value={date} allowClear={false} onChange={(value) => value && setDate(value)} />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          两边各记各的：潮位站出每天露滩时段、外业按地块排测次；这里只在排期前按地块 + 日期对账，不改对方数据。
        </Typography.Text>
      </Space>

      <Card size="small" title={`${dateStr} 当天露滩时段`} style={{ marginBottom: 14 }}>
        {dayWindows.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="该站当天没有露滩时段记录（当天作业若无硬凑确认，将全部挂起）"
          />
        ) : (
          <Table rowKey="id" size="small" columns={windowColumns} dataSource={dayWindows} pagination={false} />
        )}
      </Card>

      {daySurveys.some((row) => row.tideStatus === 'suspended') ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="有测次停在露滩时段外、挂起待复核"
          description="挂起期间不会为这些地块生成补植计划；确认涨潮硬凑可照收，或在验收台修正作业时刻后按新时段重核。"
        />
      ) : null}

      <Card size="small" title="外业测次（按地块）">
        <Table<Survey>
          rowKey="id"
          size="small"
          loading={loading}
          columns={surveyColumns}
          dataSource={daySurveys}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={selectedStationId === '' ? '请先选择潮位站' : '该站地块当天没有外业测次'}
              />
            ),
          }}
        />
      </Card>
    </div>
  );
}
