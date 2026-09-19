import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getPlan, savePlan, setRecentPlanId } from '../db';
import { createHistoryManager } from '../history';
import { getConflictMap, getTableStats, generateId } from '../utils';
import type { Plan as PlanType, Command, ChangeLog, Guest } from '../types';
import GuestPool from '../components/GuestPool';
import Canvas from '../components/Canvas';
import RulesPanel from '../components/RulesPanel';
import StatsBar from '../components/StatsBar';

/** 老数据兼容：补 logs 字段 */
function normalize(p: PlanType): PlanType {
  return { ...p, logs: p.logs ?? [] };
}

export default function PlanPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [plan, setPlan] = useState<PlanType | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedGuestId, setSelectedGuestId] = useState<string | null>(null);
  const [dragGuestId, setDragGuestId] = useState<string | null>(null);
  const historyRef = useRef<ReturnType<typeof createHistoryManager> | null>(null);
  const [conflictMap, setConflictMap] = useState<Map<string, string[]>>(new Map());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!id) return;
    getPlan(id).then((p) => {
      if (!p) {
        const fallback = normalize({ id, name: '未命名方案', tables: [], guests: [], rules: [], updatedAt: Date.now() });
        historyRef.current = createHistoryManager(fallback);
        setPlan(fallback);
      } else {
        const np = normalize(p);
        historyRef.current = createHistoryManager(np);
        setPlan(np);
        setRecentPlanId(id);
      }
      setLoading(false);
    });
  }, [id]);

  useEffect(() => {
    if (!plan) return;
    setConflictMap(getConflictMap(plan));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      savePlan(plan);
    }, 500);
  }, [plan]);

  const dispatch = useCallback((command: Command) => {
    if (!historyRef.current) return;
    const current = historyRef.current.current();
    historyRef.current.push(current, command);
    setPlan(historyRef.current.current());
  }, []);

  const handleUndo = useCallback(() => {
    if (!historyRef.current) return;
    const p = historyRef.current.undo();
    if (p) setPlan(p);
  }, []);

  const handleRedo = useCallback(() => {
    if (!historyRef.current) return;
    const p = historyRef.current.redo();
    if (p) setPlan(p);
  }, []);

  /** 微信名单批量导入：新增宾客 + 写一条导入日志，作为一次可撤销/可退回的操作 */
  const handleImportBatch = useCallback(
    (
      newGuests: Guest[],
      meta: { batchId: string; familyCount: number; adults: number; children: number },
    ) => {
      if (!historyRef.current || newGuests.length === 0) return;
      const current = historyRef.current.current();
      const log: ChangeLog = {
        id: generateId(),
        ts: Date.now(),
        kind: 'import',
        summary: `导入 ${meta.familyCount} 家 ${newGuests.length} 位（大人 ${meta.adults}${
          meta.children > 0 ? `、小孩 ${meta.children}` : ''
        }）`,
        batchId: meta.batchId,
        guestIds: newGuests.map((g) => g.id),
      };
      const next: PlanType = {
        ...current,
        guests: [...current.guests, ...newGuests],
        logs: [log, ...(current.logs ?? [])].slice(0, 100),
      };
      historyRef.current.push(current, { type: 'updatePlan', plan: next });
      setPlan(historyRef.current.current());
    },
    [],
  );

  /** 整批退回：删掉这一批导入的宾客（含已拖到桌上的座位与相关规则），并补一条退回日志 */
  const handleRollbackBatch = useCallback((log: ChangeLog) => {
    if (!historyRef.current) return;
    const current = historyRef.current.current();
    const ids = new Set(log.guestIds ?? []);
    if (ids.size === 0) return;
    const guests = current.guests.filter((g) => !ids.has(g.id));
    const tables = current.tables.map((t) => ({
      ...t,
      seatOrder: t.seatOrder.filter((gid) => !ids.has(gid)),
    }));
    const rules = current.rules.filter((r) => !ids.has(r.a) && !ids.has(r.b));
    const removed = current.guests.length - guests.length;
    const rollbackLog: ChangeLog = {
      id: generateId(),
      ts: Date.now(),
      kind: 'rollback',
      summary: `整批退回「${log.summary}」，删除 ${removed} 位`,
    };
    const updatedLogs = (current.logs ?? []).map((l) =>
      l.id === log.id ? { ...l, rolledBack: true } : l,
    );
    const next: PlanType = {
      ...current,
      guests,
      tables,
      rules,
      logs: [rollbackLog, ...updatedLogs].slice(0, 100),
    };
    historyRef.current.push(current, { type: 'updatePlan', plan: next });
    setPlan(historyRef.current.current());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, handleRedo]);

  if (loading) return <div className="plan-loading">加载中...</div>;
  if (!plan) return <div className="plan-loading">方案不存在</div>;

  const stats = getTableStats(plan);

  return (
    <div className="plan-page">
      <header className="plan-header">
        <div className="header-left">
          <button className="btn-back" onClick={() => navigate('/')}>返回</button>
          <input
            className="plan-name-input"
            value={plan.name}
            onChange={(e) => dispatch({ type: 'updatePlan', plan: { ...plan, name: e.target.value } })}
          />
        </div>
        <div className="header-actions">
          <button onClick={handleUndo} disabled={!historyRef.current?.canUndo()}>撤销</button>
          <button onClick={handleRedo} disabled={!historyRef.current?.canRedo()}>重做</button>
          <button onClick={() => navigate(`/plan/${plan.id}/print`)}>打印 / 导出</button>
        </div>
      </header>
      <StatsBar stats={stats} />
      <div className="plan-body">
        <GuestPool
          guests={plan.guests}
          logs={plan.logs ?? []}
          selectedId={selectedGuestId}
          onSelect={setSelectedGuestId}
          onAdd={(g) => dispatch({ type: 'addGuest', guest: g })}
          onRemove={(gid) => dispatch({ type: 'removeGuest', guestId: gid })}
          onDragStart={setDragGuestId}
          conflictMap={conflictMap}
          onUpdate={(g) => {
            const guests = plan.guests.map((gg) => gg.id === g.id ? g : gg);
            dispatch({ type: 'updateGuests', guests });
          }}
          onImportBatch={handleImportBatch}
          onRollbackBatch={handleRollbackBatch}
        />
        <Canvas
          plan={plan}
          dragGuestId={dragGuestId}
          setDragGuestId={setDragGuestId}
          conflictMap={conflictMap}
          dispatch={dispatch}
        />
        <RulesPanel
          plan={plan}
          dispatch={dispatch}
        />
      </div>
    </div>
  );
}
