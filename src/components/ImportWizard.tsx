import { useMemo, useState } from 'react';
import type { ChangeLogEntry, Guest, GuestRole } from '../types';
import { generateId } from '../utils';
import {
  countParsedHeads,
  parseGuestPaste,
  type ParseIssue,
  type ParseResult,
  type ParsedPerson,
} from '../importParser';

type Props = {
  existingGuests: Guest[];
  onClose: () => void;
  /** 确认导入：宾客列表（id 已生成）+ 改动记录，由父组件用 importGuests 命令原子写入 */
  onConfirm: (guests: Guest[], log: ChangeLogEntry, totalHeads: number) => void;
};

type Overrides = {
  name?: string;
  role?: GuestRole;
  childSeat?: boolean;
  skipped?: boolean;
};

type DupChoice = 'family' | 'two';

const ROLE_LABEL: Record<GuestRole, string> = {
  main: '主客',
  companion: '随行',
  child: '小孩',
};

const SEATS_PER_TABLE_KEY = 'seatsPerTable';
const getSeatsPerTable = () => {
  const v = parseInt(localStorage.getItem(SEATS_PER_TABLE_KEY) || '10', 10);
  return v >= 1 && v <= 30 ? v : 10;
};

const PLACEHOLDER_TEXT = `把微信群里的名单整段贴进来，例如：

张三 带老婆一个小孩
李四（单位：教育局，13800138000）
王五夫妇 2大1小
赵六一家三口
孙七 住建局 138 0013 8000 同事`;

export default function ImportWizard({ existingGuests, onClose, onConfirm }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [text, setText] = useState('');
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);

  // personKey 级别的修改（改名 / 改身份 / 勾选剔除）
  const [overrides, setOverrides] = useState<Record<string, Overrides>>({});
  // 「没认出姓名」的行：手工指定的姓名，key = 行号
  const [manualNames, setManualNames] = useState<Record<number, string>>({});
  // 段内重名：每条 dup-in-paste issue 的选择（必须作答）
  const [dupChoices, setDupChoices] = useState<Record<string, DupChoice>>({});
  // 与已有重名：是否仍要导入（默认仍导入）
  const [dupExisting, setDupExisting] = useState<Record<string, 'add' | 'skip'>>({});
  // 整行跳过（含手工命名行）
  const [skippedLines, setSkippedLines] = useState<Set<number>>(new Set());

  const [seatsPerTable, setSeatsPerTable] = useState(getSeatsPerTable());

  const existingNames = useMemo(() => existingGuests.filter((g) => g.role !== 'child').map((g) => g.name), [existingGuests]);

  const handleParse = () => {
    const result = parseGuestPaste(text, existingNames);
    setParseResult(result);
    setStep(2);
  };

  const setOverride = (key: string, patch: Overrides) =>
    setOverrides((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  /* ------- 段内重名分组（同名的两个主客） ------- */
  const dupGroups = useMemo(() => {
    if (!parseResult) return [];
    return parseResult.issues.filter((i) => i.kind === 'dup-in-paste');
  }, [parseResult]);

  /** 某主客在「同一家」选择下是否被并入（被并入的主客及其家属跳过） */
  const mergedMainKeys = useMemo(() => {
    const set = new Set<string>();
    for (const iss of dupGroups) {
      if (dupChoices[iss.id] === 'family' && iss.personKey) set.add(iss.personKey);
    }
    return set;
  }, [dupGroups, dupChoices]);

  /** 「两个人」选择下，后出现的主客需要整体改名（本人+随属） */
  const renameFamilyByMain = useMemo(() => {
    const map = new Map<string, string>(); // mainKey -> 后缀
    for (const iss of dupGroups) {
      if (dupChoices[iss.id] === 'two' && iss.personKey) map.set(iss.personKey, '②');
    }
    return map;
  }, [dupGroups, dupChoices]);

  /** 「与已有重名」选择跳过的主客 key */
  const skipExistingKeys = useMemo(() => {
    const set = new Set<string>();
    if (!parseResult) return set;
    for (const iss of parseResult.issues) {
      if (iss.kind === 'dup-existing' && dupExisting[iss.id] === 'skip' && iss.personKey) {
        set.add(iss.personKey);
      }
    }
    return set;
  }, [parseResult, dupExisting]);

  /* ------- 把每个主客和他的随行/小孩归到一组，用于改名与跳过联动 ------- */
  const groupPersonsByMain = useMemo(() => {
    type Group = { line: number; main?: ParsedPerson; others: ParsedPerson[] };
    const groups: Group[] = [];
    if (!parseResult) return groups;
    for (const row of parseResult.rows) {
      let cur: Group | null = null;
      for (const p of row.persons) {
        if (p.role === 'main') {
          cur = { line: row.line, main: p, others: [] };
          groups.push(cur);
        } else if (cur) {
          cur.others.push(p);
        }
      }
    }
    return groups;
  }, [parseResult]);

  const mainKeyOf = (personKey: string): string | null => {
    for (const g of groupPersonsByMain) {
      if (g.main?.key === personKey) return g.main.key;
      for (const o of g.others) if (o.key === personKey) return g.main?.key ?? null;
    }
    return null;
  };

  /** 主客 key -> 生效后的主客姓名（随属/小孩名字据此联动） */
  const mainDisplayName = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groupPersonsByMain) {
      if (!g.main) continue;
      const ov = overrides[g.main.key];
      const suffix = renameFamilyByMain.get(g.main.key);
      const name = ov?.name ?? g.main.name;
      map.set(g.main.key, suffix && !ov?.name ? `${name}${suffix}` : name);
    }
    return map;
  }, [groupPersonsByMain, overrides, renameFamilyByMain]);

  /** 生效条目：应用所有选择与编辑后的最终名单 */
  const effectivePersons = useMemo(() => {
    if (!parseResult) return [];
    const list: { person: ParsedPerson; displayName: string; role: GuestRole; childSeat: boolean; tags: string[]; skipped: boolean; line: number }[] = [];

    // 手工命名的「没认出姓名」行
    const manualLineSet = new Set(
      parseResult.issues.filter((i) => i.kind === 'no-name').map((i) => i.line),
    );

    for (const row of parseResult.rows) {
      for (const p of row.persons) {
        const ov = overrides[p.key] || {};
        const mk = mainKeyOf(p.key);
        const suffix = mk ? renameFamilyByMain.get(mk) : undefined;
        // 随属/小孩：手工改名优先；否则跟着主客的生效姓名重新拼，避免主客改了错别字后家属还挂着旧名字
        let displayName: string;
        if (ov.name) {
          displayName = ov.name;
        } else if (p.role === 'main') {
          displayName = suffix ? `${p.name}${suffix}` : p.name;
        } else {
          const head = (mk && mainDisplayName.get(mk)) || p.name;
          const tail = p.role === 'child'
            ? `小孩${p.name.match(/小孩(\d+)$/)?.[1] || ''}`
            : p.relation || '家属';
          displayName = `${head}${tail}`;
        }
        const role = ov.role ?? p.role;
        const childSeat = ov.childSeat ?? p.childSeat;
        let skipped = !!ov.skipped || skippedLines.has(row.line);
        if (mk && (mergedMainKeys.has(mk) || skipExistingKeys.has(mk))) skipped = true;
        list.push({ person: p, displayName, role, childSeat, tags: p.tags, skipped, line: row.line });
      }
      // 手工补名的行生成一个主客
      if (manualLineSet.has(row.line) && row.persons.length === 0) {
        const manual = (manualNames[row.line] || '').trim();
        if (manual) {
          list.push({
            person: {
              key: `manual-${row.line}`,
              sourceLine: row.line,
              role: 'main',
              name: manual,
              childSeat: false,
              tags: [],
            },
            displayName: manual,
            role: 'main',
            childSeat: false,
            tags: [],
            skipped: skippedLines.has(row.line),
            line: row.line,
          });
        }
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parseResult, overrides, manualNames, skippedLines, mergedMainKeys, skipExistingKeys, renameFamilyByMain, groupPersonsByMain, mainDisplayName]);

  const skipKeySet = useMemo(
    () => new Set(effectivePersons.filter((e) => e.skipped).map((e) => e.person.key)),
    [effectivePersons],
  );

  const heads = useMemo(
    () => (parseResult ? countParsedHeads(parseResult, skipKeySet) : { adults: 0, children: 0, main: 0, total: 0 }),
    [parseResult, skipKeySet],
  );

  /** 是否还有没处理完的阻塞问题 */
  const blockingErrors = useMemo(() => {
    if (!parseResult) return [] as ParseIssue[];
    return parseResult.issues.filter((iss) => {
      if (iss.level !== 'error') return false;
      if (iss.kind === 'dup-in-paste') return !dupChoices[iss.id];
      if (iss.kind === 'unknown-char') {
        const ov = iss.personKey ? overrides[iss.personKey] : undefined;
        // 改过名且新名字不含可疑字符，视为已核对
        if (ov?.name && !/[?？□■✕❌�*＊Xx〇]/.test(ov.name)) return false;
        return true;
      }
      if (iss.kind === 'no-name') {
        // 手工填了名字或整行跳过即算处理
        return !(manualNames[iss.line]?.trim() || skippedLines.has(iss.line));
      }
      return true;
    });
  }, [parseResult, dupChoices, overrides, manualNames, skippedLines]);

  const suggestedTables = Math.max(1, Math.ceil(heads.total / seatsPerTable));

  const toggleLine = (line: number) =>
    setSkippedLines((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });

  const handleConfirm = () => {
    if (!parseResult) return;
    const batchId = generateId();
    const now = Date.now();
    const guests: Guest[] = effectivePersons
      .filter((e) => !e.skipped && e.displayName.trim())
      .map((e) => ({
        id: generateId(),
        name: e.displayName.trim(),
        tags: e.tags,
        partySize: 1,
        childSeat: e.role === 'child' ? true : e.childSeat,
        role: e.role,
        batchId,
        note: `第 ${e.line} 行导入`,
      }));

    const strippedCount = parseResult.stripped.length;
    const log: ChangeLogEntry = {
      id: generateId(),
      batchId,
      time: now,
      kind: 'import',
      label: `微信群名单导入 · ${heads.total} 人`,
      detail: `主客 ${heads.main} 人，随行 ${heads.adults - heads.main} 人，小孩 ${heads.children} 人${
        strippedCount ? `；已剔除手机号/单位等 ${strippedCount} 条` : ''
      }；建议 ${suggestedTables} 桌（每桌 ${seatsPerTable} 人）`,
      sourcePreview: text.trim().slice(0, 80),
      addedGuests: guests.length,
    };
    onConfirm(guests, log, heads.total);
  };

  /* ============================== 渲染 ============================== */

  const errorIssues = parseResult?.issues.filter((i) => i.level === 'error') ?? [];
  const warningIssues = parseResult?.issues.filter((i) => i.level === 'warning') ?? [];

  const renderIssueCard = (iss: ParseIssue) => {
    const person = iss.personKey
      ? parseResult?.rows.flatMap((r) => r.persons).find((p) => p.key === iss.personKey)
      : undefined;
    const isBlocking = blockingErrors.some((b) => b.id === iss.id);

    return (
      <div key={iss.id} className={`iw-issue ${iss.kind} ${isBlocking ? 'unresolved' : 'resolved'}`}>
        <div className="iw-issue-msg">
          <span className={`iw-issue-badge ${iss.level}`}>{iss.level === 'error' ? '需核对' : '提示'}</span>
          {iss.message}
        </div>

        {iss.kind === 'unknown-char' && person && (
          <div className="iw-issue-actions">
            <input
              className="iw-name-input"
              defaultValue={overrides[person.key]?.name ?? person.name}
              placeholder="输入正确的名字"
              onChange={(e) => setOverride(person.key, { name: e.target.value })}
            />
            <button
              className="iw-btn-small"
              onClick={() => setOverride(person.key, { skipped: true })}
            >
              认不出，先不导这个人
            </button>
          </div>
        )}

        {iss.kind === 'no-name' && (
          <div className="iw-issue-actions">
            <input
              className="iw-name-input"
              value={manualNames[iss.line] ?? ''}
              placeholder={`给第 ${iss.line} 行手工指定姓名`}
              onChange={(e) => setManualNames((m) => ({ ...m, [iss.line]: e.target.value }))}
            />
            <button className="iw-btn-small" onClick={() => toggleLine(iss.line)}>
              {skippedLines.has(iss.line) ? '取消跳过' : '整行跳过'}
            </button>
          </div>
        )}

        {iss.kind === 'dup-in-paste' && (
          <div className="iw-dup-choice">
            <label className={dupChoices[iss.id] === 'family' ? 'picked' : ''}>
              <input
                type="radio"
                name={iss.id}
                checked={dupChoices[iss.id] === 'family'}
                onChange={() => setDupChoices((c) => ({ ...c, [iss.id]: 'family' }))}
              />
              是同一家（合并，保留第 {iss.line} 行之前那份，本行家属人数会并入）
            </label>
            <label className={dupChoices[iss.id] === 'two' ? 'picked' : ''}>
              <input
                type="radio"
                name={iss.id}
                checked={dupChoices[iss.id] === 'two'}
                onChange={() => setDupChoices((c) => ({ ...c, [iss.id]: 'two' }))}
              />
              是两个人（第 {iss.line} 行这位自动加后缀②，下一步可改名）
            </label>
          </div>
        )}

        {iss.kind === 'dup-existing' && (
          <div className="iw-dup-choice">
            <label className={dupExisting[iss.id] !== 'skip' ? 'picked' : ''}>
              <input
                type="radio"
                name={iss.id}
                checked={dupExisting[iss.id] !== 'skip'}
                onChange={() => setDupExisting((c) => ({ ...c, [iss.id]: 'add' }))}
              />
              仍要导入（可能是同名不同人）
            </label>
            <label className={dupExisting[iss.id] === 'skip' ? 'picked' : ''}>
              <input
                type="radio"
                name={iss.id}
                checked={dupExisting[iss.id] === 'skip'}
                onChange={() => setDupExisting((c) => ({ ...c, [iss.id]: 'skip' }))}
              />
              不导入（名单里已有）
            </label>
          </div>
        )}

        {(iss.kind === 'ambiguous' || iss.kind === 'multi-name') && (
          <div className="iw-issue-hint">下一步可在预览里逐人调整、勾掉。</div>
        )}
      </div>
    );
  };

  return (
    <div className="iw-overlay" onClick={onClose}>
      <div className="iw-modal" onClick={(e) => e.stopPropagation()}>
        <div className="iw-header">
          <h2>微信群名单导入</h2>
          <div className="iw-steps">
            <span className={step === 1 ? 'active' : ''}>1 粘贴名单</span>
            <span className="arrow">→</span>
            <span className={step === 2 ? 'active' : ''}>2 核对问题</span>
            <span className="arrow">→</span>
            <span className={step === 3 ? 'active' : ''}>3 预览算席</span>
          </div>
          <button className="iw-close" onClick={onClose}>×</button>
        </div>

        <div className="iw-body">
          {step === 1 && (
            <div className="iw-step1">
              <textarea
                className="iw-textarea"
                placeholder={PLACEHOLDER_TEXT}
                value={text}
                onChange={(e) => setText(e.target.value)}
                autoFocus
              />
              <p className="iw-tip">
                直接整段粘贴即可，不用先整理。系统会自动：拆主客与随行、标出小孩、剔除手机号/单位/微信/邮箱；
                重名和认不出的字会在下一步让你核对，所有问题都标了原文行号。
              </p>
            </div>
          )}

          {step === 2 && parseResult && (
            <div className="iw-step2">
              {parseResult.issues.length === 0 && (
                <div className="iw-allgood">✓ 没有发现需要核对的问题，可以直接看预览。</div>
              )}
              {errorIssues.length > 0 && (
                <div className="iw-issue-group">
                  <h4>必须处理（{errorIssues.length}）</h4>
                  {errorIssues.map(renderIssueCard)}
                </div>
              )}
              {warningIssues.length > 0 && (
                <div className="iw-issue-group">
                  <h4>建议核对（{warningIssues.length}）</h4>
                  {warningIssues.map(renderIssueCard)}
                </div>
              )}
              {parseResult.stripped.length > 0 && (
                <div className="iw-stripped">
                  <h4>已自动剔除的多余内容（{parseResult.stripped.length}）</h4>
                  <div className="iw-stripped-list">
                    {parseResult.stripped.map((s, i) => (
                      <span key={i} className={`iw-strip-tag ${s.kind}`}>
                        第{s.line}行 · {s.kind === 'phone' ? '手机号' : s.kind === 'org' ? '单位' : s.kind === 'wechat' ? '微信' : '邮箱'}：{s.value}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && parseResult && (
            <div className="iw-step3">
              <div className="iw-summary">
                <div className="iw-summary-item">主客 <b>{heads.main}</b></div>
                <div className="iw-summary-item">随行 <b>{heads.adults - heads.main}</b></div>
                <div className="iw-summary-item">小孩 <b>{heads.children}</b></div>
                <div className="iw-summary-item total">总人头 <b>{heads.total}</b></div>
                <div className="iw-summary-item seats">
                  每桌
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={seatsPerTable}
                    onChange={(e) => {
                      const v = Math.max(1, Math.min(30, parseInt(e.target.value) || 10));
                      setSeatsPerTable(v);
                      localStorage.setItem(SEATS_PER_TABLE_KEY, String(v));
                    }}
                  />
                  人，预计需 <b>{suggestedTables}</b> 桌
                </div>
              </div>

              <div className="iw-preview">
                {parseResult.rows.map((row) => {
                  const entries = effectivePersons.filter((e) => e.line === row.line);
                  const lineSkipped = skippedLines.has(row.line);
                  return (
                    <div key={row.line} className={`iw-row ${lineSkipped ? 'line-skip' : ''}`}>
                      <div className="iw-row-head">
                        <label className="iw-line-check">
                          <input type="checkbox" checked={!lineSkipped} onChange={() => toggleLine(row.line)} />
                          <span className="iw-line-no">第 {row.line} 行</span>
                        </label>
                        <span className="iw-raw" title={row.raw}>{row.raw}</span>
                        {row.skipped && <span className="iw-row-flag decline">{row.skipped}</span>}
                        {row.stripped.length > 0 && (
                          <span className="iw-row-flag stripped">
                            已剔 {row.stripped.map((s) => (s.kind === 'phone' ? '手机' : s.kind === 'org' ? '单位' : s.kind)).join('、')}
                          </span>
                        )}
                      </div>
                      {row.skipped && <div className="iw-skipped-line">（此行不导入）</div>}
                      {entries.map((e) => (
                        <div key={e.person.key} className={`iw-entry ${e.skipped ? 'entry-skip' : ''} ${e.role}`}>
                          <label className="iw-entry-check">
                            <input
                              type="checkbox"
                              checked={!e.skipped}
                              onChange={() => setOverride(e.person.key, { skipped: !e.skipped })}
                            />
                          </label>
                          <input
                            className="iw-entry-name"
                            value={e.displayName}
                            onChange={(ev) => setOverride(e.person.key, { name: ev.target.value })}
                          />
                          <select
                            value={e.role}
                            onChange={(ev) => setOverride(e.person.key, { role: ev.target.value as GuestRole, childSeat: ev.target.value === 'child' })}
                          >
                            <option value="main">主客</option>
                            <option value="companion">随行</option>
                            <option value="child">小孩</option>
                          </select>
                          <span className={`iw-role-tag ${e.role}`}>{ROLE_LABEL[e.role]}</span>
                          {e.person.inferred && <span className="iw-inferred" title="人数是按「全家/N口」之类说法推测的">推测</span>}
                        </div>
                      ))}
                      {row.persons.length === 0 && !(manualNames[row.line] || '').trim() && !row.skipped && (
                        <div className="iw-row-empty">无可用姓名{row.stripped.length > 0 ? '（只有联系方式/单位）' : ''}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="iw-footer">
          {step === 1 && (
            <>
              <button className="iw-btn-ghost" onClick={onClose}>取消</button>
              <button className="iw-btn-primary" disabled={!text.trim()} onClick={handleParse}>
                解析名单
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <button className="iw-btn-ghost" onClick={() => setStep(1)}>上一步</button>
              <span className="iw-block-count">
                {blockingErrors.length > 0 ? `还有 ${blockingErrors.length} 个问题未处理` : '问题已处理完'}
              </span>
              <button
                className="iw-btn-primary"
                disabled={blockingErrors.length > 0}
                onClick={() => setStep(3)}
              >
                去预览算席位
              </button>
            </>
          )}
          {step === 3 && (
            <>
              <button className="iw-btn-ghost" onClick={() => setStep(2)}>返回核对</button>
              <span className="iw-block-count">
                将导入 {heads.total} 人 · 预计 {suggestedTables} 桌
              </span>
              <button className="iw-btn-primary" disabled={heads.total === 0} onClick={handleConfirm}>
                确认导入
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
