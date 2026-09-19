import { useState } from 'react';
import type { ChangeLog, Guest } from '../types';

interface Props {
  logs: ChangeLog[];
  guests: Guest[];
  /** 整批退回：返回要删除的宾客 id（一批导入进来的人） */
  onRollback: (log: ChangeLog) => void;
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const KIND_LABEL: Record<ChangeLog['kind'], string> = {
  import: '导入',
  rollback: '退回',
  edit: '编辑',
};

export default function ChangeLogPanel({ logs, guests, onRollback }: Props) {
  const [open, setOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const guestById = new Map(guests.map((g) => [g.id, g]));

  const handleRollback = (log: ChangeLog) => {
    onRollback(log);
    setConfirmId(null);
  };

  return (
    <div className="changelog-panel">
      <button className="changelog-toggle" onClick={() => setOpen((v) => !v)}>
        改动记录（{logs.length}）{open ? ' ▲' : ' ▼'}
      </button>
      {open && (
        <div className="changelog-list">
          {logs.length === 0 && <div className="changelog-empty">暂无改动记录</div>}
          {logs.map((log) => {
            const remaining = log.guestIds?.filter((id) => guestById.has(id)).length ?? 0;
            const canRollback =
              log.kind === 'import' && !log.rolledBack && (log.guestIds?.length ?? 0) > 0;
            return (
              <div key={log.id} className={`changelog-item ${log.rolledBack ? 'rolled' : ''}`}>
                <div className="changelog-head">
                  <span className={`changelog-kind kind-${log.kind}`}>{KIND_LABEL[log.kind]}</span>
                  <span className="changelog-summary" title={log.summary}>{log.summary}</span>
                  <span className="changelog-time">{formatTime(log.ts)}</span>
                </div>
                {canRollback && (
                  <div className="changelog-actions">
                    {confirmId === log.id ? (
                      <>
                        <span className="rollback-ask">
                          该批还剩 {remaining} 位在名单里，整批退回？
                        </span>
                        <button className="btn-danger-mini" onClick={() => handleRollback(log)}>
                          确认退回
                        </button>
                        <button className="btn-ghost-mini" onClick={() => setConfirmId(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <button className="btn-ghost-mini" onClick={() => setConfirmId(log.id)}>
                        整批退回（剩 {remaining} 位）
                      </button>
                    )}
                  </div>
                )}
                {log.kind === 'import' && log.rolledBack && (
                  <div className="changelog-note">已整批退回</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
