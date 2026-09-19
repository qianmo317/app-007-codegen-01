import { useMemo, useRef, useState } from 'react';
import {
  parseGuestList,
  findDuplicates,
  summarizeEntries,
  type ParsedEntry,
  type ParseResult,
  type ImportMember,
  type DuplicateGroup,
} from '../utils/importParser';
import type { Guest } from '../types';
import { generateId } from '../utils';

const SAMPLE_TEXT = `张三 19:32
我报名！张三，带老婆和一个小孩，手机13800138000，市人民医院
李四 19:35
李四 带父母 2大1小
王五
王五条 带家属2位，139-0013-9000，某某有限公司
赵六（男方亲属）
赵六（同事）
钱七 一家三口
孙八 待定
周九 去不了，在外地赶不回来
吴十、郑十一、冯十二
陈囗囗 带小孩`;

type Stage = 'input' | 'review';

interface Props {
  existingGuests: Guest[];
  onClose: () => void;
  /** 确认导入：回传本批宾客与汇总信息，由父组件写入名单 + 记录日志 */
  onCommit: (
    guests: Guest[],
    meta: { batchId: string; familyCount: number; adults: number; children: number },
  ) => void;
}

export default function ImportWizard({ existingGuests, onClose, onCommit }: Props) {
  const [stage, setStage] = useState<Stage>('input');
  const [text, setText] = useState('');
  const [entries, setEntries] = useState<ParsedEntry[]>([]);
  const [parseInfo, setParseInfo] = useState<ParseResult | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [highlightLine, setHighlightLine] = useState<number | null>(null);
  const [attempted, setAttempted] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const handleParse = () => {
    if (!text.trim()) return;
    const result = parseGuestList(text);
    setParseInfo(result);
    setEntries(result.entries);
    setDuplicates(findDuplicates(result.entries, existingGuests));
    setStage('review');
    setAttempted(false);
    setHighlightLine(null);
  };

  const updateEntry = (id: string, patch: Partial<ParsedEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  const updateMember = (entryId: string, idx: number, patch: Partial<ImportMember>) => {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.id !== entryId) return e;
        const members = e.members.map((m, i) => (i === idx ? { ...m, ...patch } : m));
        return { ...e, members };
      }),
    );
  };

  const removeMember = (entryId: string, idx: number) => {
    setEntries((prev) =>
      prev.map((e) =>
        e.id === entryId ? { ...e, members: e.members.filter((_, i) => i !== idx) } : e,
      ),
    );
  };

  const setResolution = (name: string, r: 'same' | 'two') => {
    setDuplicates((prev) => prev.map((g) => (g.name === name ? { ...g, resolution: r } : g)));
  };

  const selectedEntries = entries.filter((e) => e.selected);
  const summary = useMemo(() => summarizeEntries(entries), [entries]);

  const unresolvedDup = duplicates.some(
    (g) =>
      g.resolution === null &&
      g.entryIds.some((id) => entries.find((e) => e.id === id)?.selected),
  );

  const handleCommit = () => {
    setAttempted(true);
    if (unresolvedDup) {
      listRef.current
        ?.querySelector('.dup-block')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const batchId = generateId();
    const guests: Guest[] = [];

    // 每个重复名组：
    // - same：第一个被勾选的条目是“主家”，其余条目的主客不再重复建，随行挂到同一主客下；
    //   若名单里已有同名，主家直接复用已有宾客。
    // - two：本次每个条目各建一个主客，名字加（2）（3）后缀。
    const hostEntryId = new Map<string, string>();
    const mergeIntoExisting = new Set<string>();
    const suffixOfEntry = new Map<string, number>();

    for (const g of duplicates) {
      const selectedInGroup = g.entryIds.filter((id) =>
        selectedEntries.some((e) => e.id === id),
      );
      if (g.resolution === 'same' && selectedInGroup.length > 0) {
        hostEntryId.set(g.name, selectedInGroup[0]);
        if (g.existingGuestIds.length > 0) mergeIntoExisting.add(selectedInGroup[0]);
      }
      if (g.resolution === 'two') {
        let n = g.existingGuestIds.length;
        for (const id of selectedInGroup) {
          n += 1;
          if (n > 1) suffixOfEntry.set(id, n);
        }
      }
    }

    const primaryIdByEntry = new Map<string, string>();
    for (const e of selectedEntries) {
      const host = hostEntryId.get(e.primaryName);
      if (!host) {
        primaryIdByEntry.set(e.id, generateId());
      } else if (e.id === host) {
        const dup = duplicates.find((g) => g.name === e.primaryName)!;
        primaryIdByEntry.set(
          e.id,
          mergeIntoExisting.has(e.id) ? dup.existingGuestIds[0] : generateId(),
        );
      } else {
        primaryIdByEntry.set(e.id, primaryIdByEntry.get(host)!);
      }
    }

    for (const e of selectedEntries) {
      const isHost = hostEntryId.get(e.primaryName) === e.id;
      const mergedAway = hostEntryId.has(e.primaryName) && !isHost;
      const reuseExisting = mergeIntoExisting.has(e.id);
      const suffix = suffixOfEntry.get(e.id);

      for (const m of e.members) {
        const primaryId = primaryIdByEntry.get(e.id)!;

        if (m.kind === 'primary') {
          if (mergedAway || reuseExisting) continue;
          guests.push({
            id: primaryId,
            name: suffix ? `${e.primaryName}（${suffix}）` : e.primaryName,
            tags: e.tags.filter((t) => t !== '儿童'),
            partySize: 1,
            batchId,
            note: `来自第${e.line}行`,
          });
        } else {
          guests.push({
            id: generateId(),
            name: m.name ||
              (m.kind === 'child'
                ? `${e.primaryName}家小孩`
                : `${e.primaryName}家${m.relation}`),
            tags: m.kind === 'child' ? ['儿童'] : ['家属'],
            partySize: 1,
            childSeat: m.childSeat,
            primaryId,
            batchId,
            note: `${m.relation}｜来自第${e.line}行`,
          });
        }
      }
    }

    onCommit(guests, {
      batchId,
      familyCount: selectedEntries.length,
      adults: summary.adults,
      children: summary.children,
    });
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-dialog import-wizard" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>微信名单导入</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>

        {stage === 'input' && (
          <div className="wizard-body">
            <p className="wizard-tip">
              把微信群里复制的赴宴名单整段贴进来即可。系统会自动：拆出「主客 + 随行家属」、
              单独标出小孩、剔掉手机号/单位；遇到同名或认不出的字，会在下一步请你核对。
            </p>
            <textarea
              className="wizard-textarea"
              placeholder={'例如：\n张三 19:32\n张三，带老婆和一个小孩，13800138000，市人民医院\n李四 带父母\n赵六（男方亲属）'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
            <div className="wizard-row">
              <button className="btn-link" onClick={() => setText(SAMPLE_TEXT)}>
                填入示例试试
              </button>
            </div>
          </div>
        )}

        {stage === 'review' && parseInfo && (
          <div className="wizard-body review" ref={listRef}>
            {(parseInfo.warnings.length > 0 || duplicates.length > 0) && (
              <div className="review-issues">
                {parseInfo.warnings.map((w, i) => (
                  <div key={i} className={`issue-line ${w.level}`}>
                    <span className="issue-flag">{w.level === 'error' ? '需核对' : '提示'}</span>
                    <button className="issue-jump" onClick={() => setHighlightLine(w.line)}>
                      第 {w.line} 行
                    </button>
                    <span>{w.message.replace(/第 \d+ 行/, '').trim()}</span>
                  </div>
                ))}
                {duplicates.map((g) => (
                  <div key={g.name} className="dup-block issue-line">
                    <span className="issue-flag warn">重名</span>
                    <span className="dup-text">
                      「{g.name}」出现 {g.entryIds.length + g.existingGuestIds.length} 次（第{' '}
                      {g.lines.join('、') || '—'} 行
                      {g.existingGuestIds.length > 0 ? '，且名单里已有同名' : ''}）
                    </span>
                    <div className="dup-choice">
                      <label className={g.resolution === 'same' ? 'active' : ''}>
                        <input
                          type="radio"
                          name={`dup-${g.name}`}
                          checked={g.resolution === 'same'}
                          onChange={() => setResolution(g.name, 'same')}
                        />
                        同一家（随行并到一起）
                      </label>
                      <label className={g.resolution === 'two' ? 'active' : ''}>
                        <input
                          type="radio"
                          name={`dup-${g.name}`}
                          checked={g.resolution === 'two'}
                          onChange={() => setResolution(g.name, 'two')}
                        />
                        两个人（名字加序号区分）
                      </label>
                      {attempted && g.resolution === null && (
                        <span className="dup-required">请先选择</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="review-list">
              {entries.map((e) => (
                <EntryCard
                  key={e.id}
                  entry={e}
                  highlight={highlightLine === e.line}
                  dupGroup={duplicates.find((g) => g.name === e.primaryName) || null}
                  onToggle={(v) => updateEntry(e.id, { selected: v })}
                  onRename={(name) =>
                    updateEntry(e.id, {
                      primaryName: name,
                      members: e.members.map((m) =>
                        m.kind === 'primary' ? { ...m, name } : m,
                      ),
                    })
                  }
                  onMemberChange={(idx, patch) => updateMember(e.id, idx, patch)}
                  onMemberRemove={(idx) => removeMember(e.id, idx)}
                />
              ))}
              {parseInfo.skipped.length > 0 && (
                <details className="skipped-box">
                  <summary>已忽略 {parseInfo.skipped.length} 行（时间、署名、空行等）</summary>
                  {parseInfo.skipped.map((s, i) => (
                    <div key={i} className="skipped-line">
                      第{s.line}行 · {s.reason} · <span className="skipped-raw">{s.raw}</span>
                    </div>
                  ))}
                </details>
              )}
            </div>
          </div>
        )}

        <div className="modal-footer">
          {stage === 'review' && (
            <div className="wizard-summary">
              勾选 <b>{selectedEntries.length}</b> 家 · 大人 <b>{summary.adults}</b> 位
              {summary.children > 0 && (
                <> · 小孩 <b>{summary.children}</b> 位（儿童椅）</>
              )}{' '}
              · 共需席位 <b>{summary.total}</b> 个
              {summary.total > 0 && <>，按每桌 10 人约 <b>{Math.ceil(summary.total / 10)}</b> 桌</>}
            </div>
          )}
          <div className="wizard-actions">
            {stage === 'review' && (
              <button className="btn-ghost" onClick={() => setStage('input')}>
                返回修改
              </button>
            )}
            <button className="btn-ghost" onClick={onClose}>取消</button>
            {stage === 'input' ? (
              <button className="btn-primary" onClick={handleParse} disabled={!text.trim()}>
                解析名单
              </button>
            ) : (
              <button className="btn-primary" onClick={handleCommit} disabled={summary.total === 0}>
                确认导入（{summary.total} 位）
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EntryCard({
  entry,
  highlight,
  dupGroup,
  onToggle,
  onRename,
  onMemberChange,
  onMemberRemove,
}: {
  entry: ParsedEntry;
  highlight: boolean;
  dupGroup: DuplicateGroup | null;
  onToggle: (v: boolean) => void;
  onRename: (name: string) => void;
  onMemberChange: (idx: number, patch: Partial<ImportMember>) => void;
  onMemberRemove: (idx: number) => void;
}) {
  const hasError = entry.warnings.some((w) => w.includes('认不出'));
  return (
    <div
      className={`entry-card ${entry.selected ? '' : 'unselected'} ${highlight ? 'flash' : ''} ${hasError ? 'has-error' : ''}`}
    >
      <label className="entry-check">
        <input
          type="checkbox"
          checked={entry.selected}
          onChange={(ev) => onToggle(ev.target.checked)}
        />
      </label>
      <div className="entry-main">
        <div className="entry-top">
          <input className="entry-name" value={entry.primaryName} onChange={(ev) => onRename(ev.target.value)} />
          <span className="entry-line">第 {entry.line} 行</span>
          {entry.status === 'absent' && <span className="badge badge-absent">疑似不来</span>}
          {entry.status === 'pending' && <span className="badge badge-pending">待定</span>}
          {dupGroup && (
            <span className="badge badge-dup">
              重名：{dupGroup.resolution === 'same' ? '按同一家' : dupGroup.resolution === 'two' ? '按两个人' : '待确认'}
            </span>
          )}
          {entry.tags
            .filter((t) => t !== '家属')
            .map((t) => (
              <span key={t} className="badge badge-tag">{t}</span>
            ))}
        </div>
        <div className="entry-members">
          {entry.members.map((m, i) =>
            m.kind === 'primary' ? null : (
              <span key={i} className={`member-chip ${m.kind}`}>
                <input
                  className="member-name"
                  value={m.name}
                  placeholder={m.kind === 'child' ? '小孩（可留空）' : `${m.relation}（可留空）`}
                  onChange={(ev) => onMemberChange(i, { name: ev.target.value })}
                />
                {m.kind === 'child' && <span className="child-flag">儿童椅</span>}
                <button className="member-remove" onClick={() => onMemberRemove(i)}>×</button>
              </span>
            ),
          )}
        </div>
        {entry.warnings.length > 0 && (
          <div className="entry-warnings">
            {entry.warnings.map((w, i) => (
              <span key={i} className="entry-warning">⚠ {w}</span>
            ))}
          </div>
        )}
        {entry.dropped.length > 0 && (
          <div className="entry-dropped">已剔除：{entry.dropped.join('；')}</div>
        )}
        <details className="entry-raw">
          <summary>原文</summary>
          {entry.raw}
        </details>
      </div>
    </div>
  );
}
