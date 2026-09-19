import { useMemo, useState } from 'react';
import type { ChangeLogEntry, Guest } from '../types';
import { generateId } from '../utils';
import { TAG_OPTIONS } from '../types';
import ImportWizard from './ImportWizard';

interface Props {
  guests: Guest[];
  changelog: ChangeLogEntry[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (guest: Guest) => void;
  onRemove: (guestId: string) => void;
  onDragStart: (id: string | null) => void;
  conflictMap: Map<string, string[]>;
  onUpdate?: (guest: Guest) => void;
  onImport: (guests: Guest[], log: ChangeLogEntry) => void;
  onRollback: (batchId: string, log: ChangeLogEntry) => void;
}

function formatTime(t: number) {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function GuestPool({
  guests,
  changelog,
  selectedId,
  onSelect,
  onAdd,
  onRemove,
  onDragStart,
  conflictMap,
  onUpdate,
  onImport,
  onRollback,
}: Props) {
  const [showWizard, setShowWizard] = useState(false);
  const [filterTag, setFilterTag] = useState<string>('');
  const [search, setSearch] = useState('');
  const [showChangelog, setShowChangelog] = useState(false);

  /** 每个批次当前还留在名单里的人数，决定能不能退回 */
  const batchCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of guests) {
      if (g.batchId) m.set(g.batchId, (m.get(g.batchId) || 0) + 1);
    }
    return m;
  }, [guests]);

  const rolledBackBatches = useMemo(
    () => new Set(changelog.filter((l) => l.kind === 'rollback').map((l) => l.rolledBackFrom)),
    [changelog],
  );

  const filtered = guests.filter((g) => {
    const matchTag = !filterTag || g.tags.includes(filterTag);
    const matchSearch = !search || g.name.includes(search);
    return matchTag && matchSearch;
  });

  const selectedGuest = guests.find((g) => g.id === selectedId);

  const handleRollback = (entry: ChangeLogEntry) => {
    const remain = batchCounts.get(entry.batchId) || 0;
    if (!window.confirm(`确定把「${entry.label}」整批退回吗？将删除这次导入还留在名单里的 ${remain} 人（已分桌的也会撤出）。`)) return;
    onRollback(entry.batchId, {
      id: generateId(),
      batchId: generateId(),
      time: Date.now(),
      kind: 'rollback',
      label: `退回批次 · ${entry.label.replace(/^微信群名单导入/, '名单导入')}`,
      detail: `退回 ${remain} 人`,
      rolledBackFrom: entry.batchId,
      removedGuests: remain,
    });
  };

  return (
    <div className="guest-pool">
      <h3>宾客池 ({guests.length})</h3>
      <div className="pool-actions">
        <button className="btn-import" onClick={() => setShowWizard(true)}>📋 粘贴名单导入</button>
        <button onClick={() => onAdd({ id: generateId(), name: '新宾客', tags: [], partySize: 1, role: 'main' })}>添加宾客</button>
      </div>

      {showWizard && (
        <ImportWizard
          existingGuests={guests}
          onClose={() => setShowWizard(false)}
          onConfirm={(list, log) => {
            onImport(list, log);
            setShowWizard(false);
          }}
        />
      )}

      <div className="pool-filters">
        <input placeholder="搜索姓名" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
          <option value="">全部标签</option>
          {TAG_OPTIONS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      {selectedGuest && onUpdate && (
        <div className="guest-editor">
          <label>
            姓名
            <input
              value={selectedGuest.name}
              onChange={(e) => onUpdate({ ...selectedGuest, name: e.target.value })}
            />
          </label>
          <label>
            身份
            <select
              value={selectedGuest.role || 'main'}
              onChange={(e) => onUpdate({
                ...selectedGuest,
                role: e.target.value as Guest['role'],
                childSeat: e.target.value === 'child' ? true : selectedGuest.childSeat,
              })}
            >
              <option value="main">主客</option>
              <option value="companion">随行</option>
              <option value="child">小孩</option>
            </select>
          </label>
          <label>
            人数
            <input
              type="number"
              min={1}
              max={10}
              value={selectedGuest.partySize}
              onChange={(e) => onUpdate({ ...selectedGuest, partySize: Math.max(1, Math.min(10, parseInt(e.target.value) || 1)) })}
            />
          </label>
          <label>
            标签
            <div className="tag-checkboxes">
              {TAG_OPTIONS.map((tag) => (
                <label key={tag} className="tag-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedGuest.tags.includes(tag)}
                    onChange={(e) => {
                      const tags = e.target.checked
                        ? [...selectedGuest.tags, tag]
                        : selectedGuest.tags.filter((t) => t !== tag);
                      onUpdate({ ...selectedGuest, tags });
                    }}
                  />
                  {tag}
                </label>
              ))}
            </div>
          </label>
          <label>
            备注
            <input
              value={selectedGuest.note || ''}
              onChange={(e) => onUpdate({ ...selectedGuest, note: e.target.value })}
            />
          </label>
          <label className="child-seat-label">
            <input
              type="checkbox"
              checked={!!selectedGuest.childSeat}
              onChange={(e) => onUpdate({ ...selectedGuest, childSeat: e.target.checked })}
            />
            儿童椅
          </label>
        </div>
      )}
      <div className="guest-list">
        {filtered.map((g) => {
          const conflicts = conflictMap.get(g.id) || [];
          const isConflict = conflicts.length > 0;
          return (
            <div
              key={g.id}
              className={`guest-chip ${selectedId === g.id ? 'selected' : ''} ${isConflict ? 'conflict' : ''}`}
              draggable
              onDragStart={() => onDragStart(g.id)}
              onDragEnd={() => onDragStart(null)}
              onClick={() => onSelect(selectedId === g.id ? null : g.id)}
            >
              {g.role && g.role !== 'main' && <span className={`guest-role ${g.role}`}>{g.role === 'child' ? '童' : '随'}</span>}
              <span className="guest-name">{g.name}</span>
              {g.tags.length > 0 && <span className="guest-tags">{g.tags.join(',')}</span>}
              {isConflict && (
                <span
                  className="conflict-badge"
                  title={`冲突: ${conflicts.map((c) => guests.find((gg) => gg.id === c)?.name || c).join(', ')}`}
                >!</span>
              )}
              <button className="guest-remove" onClick={(e) => { e.stopPropagation(); onRemove(g.id); }}>×</button>
            </div>
          );
        })}
      </div>

      <div className="changelog-panel">
        <button className="changelog-toggle" onClick={() => setShowChangelog((s) => !s)}>
          {showChangelog ? '▾' : '▸'} 名单改动记录{changelog.length > 0 ? `（${changelog.length}）` : ''}
        </button>
        {showChangelog && (
          <div className="changelog-list">
            {changelog.length === 0 && <div className="changelog-empty">还没有导入记录。粘贴一次微信群名单后，这里会留下批次，贴错了可整批退回。</div>}
            {changelog.map((entry) => {
              const isRollback = entry.kind === 'rollback';
              const remain = batchCounts.get(entry.batchId) || 0;
              const wasRolledBack = !isRollback && rolledBackBatches.has(entry.batchId);
              return (
                <div key={entry.id} className={`changelog-item ${isRollback ? 'rollback' : ''} ${wasRolledBack ? 'rolled-back' : ''}`}>
                  <div className="changelog-row">
                    <span className="changelog-kind">{isRollback ? '↩ 退回' : '导入'}</span>
                    <span className="changelog-label" title={entry.sourcePreview}>{entry.label}</span>
                  </div>
                  <div className="changelog-meta">
                    {formatTime(entry.time)}{entry.detail ? ` · ${entry.detail}` : ''}
                  </div>
                  {!isRollback && !wasRolledBack && remain > 0 && (
                    <button className="changelog-undo" onClick={() => handleRollback(entry)}>
                      整批退回（{remain} 人）
                    </button>
                  )}
                  {!isRollback && wasRolledBack && <div className="changelog-done">已退回</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
