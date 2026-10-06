/**
 * <TideStatusTag> 潮位对账状态标签
 * 露滩有效 / 涨潮硬凑 / 挂起待复核 / 已失效重算 / 历史有效 / 历史只读。
 * 被验收台、潮位排期对账页消费。
 */
import { Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  FieldTimeOutlined,
  HistoryOutlined,
  LockOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { TIDE_STATUS_LABEL, type TideStatus } from '../../types/survey';

const STATUS_COLOR: Record<TideStatus, string> = {
  exposed: 'success',
  forced: 'orange',
  suspended: 'gold',
  invalidated: 'error',
  legacyValid: 'blue',
  legacyReadonly: 'default',
};

const STATUS_ICON: Record<TideStatus, typeof CheckCircleOutlined> = {
  exposed: CheckCircleOutlined,
  forced: WarningOutlined,
  suspended: ClockCircleOutlined,
  invalidated: FieldTimeOutlined,
  legacyValid: HistoryOutlined,
  legacyReadonly: LockOutlined,
};

const STATUS_HINT: Record<TideStatus, string> = {
  exposed: '作业起止完整落进当天露滩时段，正常入账。',
  forced: '涨潮硬凑：作业落在露滩时段外，但照常验收照收并定级。',
  suspended: '停在露滩时段外，先挂起等复核；挂起期间不生成补植计划。',
  invalidated: '潮位站改动当天时段后对不上新时段，未定级测次失效，需重算 / 复核。',
  legacyValid: '历史测次：升级时按测次日期补录了时刻来源。',
  legacyReadonly: '历史测次：补不上作业时刻来源，只读留着。',
};

export interface TideStatusTagProps {
  status: TideStatus;
  /** 定级依据的潮位表版本（>0 时附带「依据 vN」） */
  basisVersion?: number;
}

export default function TideStatusTag({ status, basisVersion = 0 }: TideStatusTagProps) {
  const Icon = STATUS_ICON[status];
  const suffix = basisVersion > 0 ? ` · 依据 v${basisVersion}` : '';
  return (
    <Tooltip title={STATUS_HINT[status]}>
      <Tag icon={<Icon />} color={STATUS_COLOR[status]} style={{ marginInlineEnd: 0 }}>
        {TIDE_STATUS_LABEL[status]}
        {suffix}
      </Tag>
    </Tooltip>
  );
}
