/**
 * /tides 潮位露滩与外业排期对账台
 * 三个子页签按职责拆分：
 * - <StationWindowsPane>：潮位站与每天露滩时段维护、潮位表导入（只重试潮位侧）
 * - <ReconcilePane>：排期前按 地块 + 日期 对账
 * - <SchedulePane>：外业按地块排测次，一段排不下顺到下一段，仍排不下挂起
 * 消费模型：TideStation、TideWindow、Plot、Survey。
 */
import { useEffect } from 'react';
import { Card, Tabs } from 'antd';
import { CloudServerOutlined, FieldTimeOutlined, SwapOutlined } from '@ant-design/icons';
import { useTideStore } from '../stores/tideStore';
import StationWindowsPane from '../components/tide/StationWindowsPane';
import ReconcilePane from '../components/tide/ReconcilePane';
import SchedulePane from '../components/tide/SchedulePane';

export default function TideBoard() {
  const init = useTideStore((state) => state.init);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <Card
      title="潮位露滩与外业排期对账台"
      styles={{ body: { paddingTop: 12 } }}
    >
      <Tabs
        defaultActiveKey="stations"
        items={[
          {
            key: 'stations',
            label: (
              <span>
                <CloudServerOutlined /> 潮位站与露滩时段
              </span>
            ),
            children: <StationWindowsPane />,
          },
          {
            key: 'reconcile',
            label: (
              <span>
                <SwapOutlined /> 排期前对账
              </span>
            ),
            children: <ReconcilePane />,
          },
          {
            key: 'schedule',
            label: (
              <span>
                <FieldTimeOutlined /> 外业排测次
              </span>
            ),
            children: <SchedulePane />,
          },
        ]}
      />
    </Card>
  );
}
