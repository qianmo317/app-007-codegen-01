import { useState } from 'react';
import type { ChangeLog, Guest } from '../types';
import { generateId } from '../utils';
import { TAG_OPTIONS } from '../types';
import ImportWizard from './ImportWizard';
import ChangeLogPanel from './ChangeLogPanel';

interface Props {
  guests: Guest[];
  logs: ChangeLog[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (guest: Guest) => void;
  onRemove: (guestId: string) => void;
  onDragStart: (id: string | null) => void;
  conflictMap: Map<string, string[]>;
  onUpdate?: (guest: Guest) => void;
  /** 批量导入：本批宾客 */
  onImportBatch: (
    guests: Guest[],
    meta: { batchId: string; familyCount: number; adults: number; children: number },
  ) => void;
  /** 整批退回 */
  onRollbackBatch: (log: ChangeLog) => void;
}

export default function GuestPool({
  guests,
  logs,
  selectedId,
  onSelect,
  onAdd,
  onRemove,
  onDragStart,
  conflictMap,
  onUpdate,
  onImportBatch,
  onRollbackBatch,
}: Props) {
  const [showImport, setShowImport] = useState(false);
  const [filterTag, setFilterTag] = useState<string>('');
  const [search, setSearch] = useState('');

  const filtered = guests.filter((g) => {
    const matchTag = !filterTag || g.tags.includes(filterTag);
    const matchSearch = !search || g.name.includes(search);
    return matchTag && matchSearch;
  });

  const selectedGuest = guests.find((g) => g.id === selectedId);

  return (
    <div className="guest-pool">
      <h3>宾客池（{guests.length} 位）</h3>
      <div className="pool-actions">
        <button className="btn-import-main" onClick={() => setShowImport(true)}>
          📋 粘贴名单导入
        </button>
        <button
          onClick={() => onAdd({ id: generateId(), name: '新宾客', tags: [], partySize: 1 })}
        >
          单个添加
        </button>
      </div>

      <ChangeLogPanel logs={logs} guests={guests} onRollback={onRollbackBatch} />

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
            标签
            <div className="tag-checkboxes">
              {TAG_OPTIONS.filter((t) => t !== '家属').map((tag) => (
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
          const isCompanion = !!g.primaryId;
          return (
            <div
              key={g.id}
              className={`guest-chip ${selectedId === g.id ? 'selected' : ''} ${isConflict ? 'conflict' : ''} ${isCompanion ? 'companion' : ''} ${g.childSeat ? 'is-child' : ''}`}
              draggable
              onDragStart={() => onDragStart(g.id)}
              onDragEnd={() => onDragStart(null)}
              onClick={() => onSelect(selectedId === g.id ? null : g.id)}
            >
              <span className="guest-name">{g.name}</span>
              {g.childSeat && <span className="mini-badge child">童</span>}
              {isCompanion && !g.childSeat && <span className="mini-badge family">随</span>}
              {g.tags.filter((t) => t !== '儿童' && t !== '家属').length > 0 && (
                <span className="guest-tags">{g.tags.filter((t) => t !== '儿童' && t !== '家属').join(',')}</span>
              )}
              {isConflict && (
                <span
                  className="conflict-badge"
                  title={`冲突: ${conflicts.map((c) => guests.find((gg) => gg.id === c)?.name || c).join(', ')}`}
                >!</span>
              )}
              <button
                className="guest-remove"
                onClick={(e) => { e.stopPropagation(); onRemove(g.id); }}
              >×</button>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="pool-empty">名单是空的，点上方“粘贴名单导入”</div>}
      </div>

      {showImport && (
        <ImportWizard
          existingGuests={guests}
          onClose={() => setShowImport(false)}
          onCommit={(batch, meta) => {
            onImportBatch(batch, meta);
            setShowImport(false);
          }}
        />
      )}
    </div>
  );
}
