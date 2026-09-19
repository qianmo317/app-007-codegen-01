import { v4 as uuidv4 } from 'uuid';
import type { Plan } from './types';

export function generateId(): string {
  return uuidv4();
}

export function createEmptyPlan(name = '未命名方案'): Plan {
  return {
    id: generateId(),
    name,
    tables: [],
    guests: [],
    rules: [],
    changelog: [],
    updatedAt: Date.now(),
  };
}

export function clonePlan(plan: Plan): Plan {
  return JSON.parse(JSON.stringify(plan));
}

export function getConflictMap(plan: Plan): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const { tables, rules } = plan;

  for (const rule of rules) {
    if (rule.type === 'apart') {
      for (const table of tables) {
        const hasA = table.seatOrder.includes(rule.a);
        const hasB = table.seatOrder.includes(rule.b);
        if (hasA && hasB) {
          if (!map.has(rule.a)) map.set(rule.a, []);
          if (!map.has(rule.b)) map.set(rule.b, []);
          if (!map.get(rule.a)!.includes(rule.b)) map.get(rule.a)!.push(rule.b);
          if (!map.get(rule.b)!.includes(rule.a)) map.get(rule.b)!.push(rule.a);
        }
      }
    } else if (rule.type === 'separate') {
      for (const table of tables) {
        const hasA = table.seatOrder.includes(rule.a);
        const hasB = table.seatOrder.includes(rule.b);
        if (hasA && hasB) {
          if (!map.has(rule.a)) map.set(rule.a, []);
          if (!map.has(rule.b)) map.set(rule.b, []);
          if (!map.get(rule.a)!.includes(rule.b)) map.get(rule.a)!.push(rule.b);
          if (!map.get(rule.b)!.includes(rule.a)) map.get(rule.b)!.push(rule.a);
        }
      }
    } else if (rule.type === 'together') {
      let same = false;
      for (const table of tables) {
        const hasA = table.seatOrder.includes(rule.a);
        const hasB = table.seatOrder.includes(rule.b);
        if (hasA && hasB) same = true;
      }
      if (!same) {
        const ta = tables.find((t) => t.seatOrder.includes(rule.a));
        const tb = tables.find((t) => t.seatOrder.includes(rule.b));
        if (ta && tb && ta.id !== tb.id) {
          if (!map.has(rule.a)) map.set(rule.a, []);
          if (!map.has(rule.b)) map.set(rule.b, []);
          if (!map.get(rule.a)!.includes(rule.b)) map.get(rule.a)!.push(rule.b);
          if (!map.get(rule.b)!.includes(rule.a)) map.get(rule.b)!.push(rule.a);
        }
      }
    }
  }
  return map;
}

export function getTableStats(plan: Plan) {
  let seated = 0;
  let capacity = 0;
  let emptySeats = 0;
  let totalHeads = 0;
  let children = 0;
  const unassigned = plan.guests.filter((g) => {
    totalHeads += g.partySize;
    if (g.role === 'child' || g.childSeat) children += 1;
    const atTable = plan.tables.some((t) => t.seatOrder.includes(g.id));
    return !atTable;
  });
  for (const t of plan.tables) {
    seated += t.seatOrder.length;
    capacity += t.capacity;
    emptySeats += Math.max(0, t.capacity - t.seatOrder.length);
  }
  return {
    seated,
    capacity,
    emptySeats,
    totalGuests: plan.guests.length,
    totalHeads,
    children,
    unassignedCount: unassigned.length,
  };
}

export function exportPlanToJSON(plan: Plan): string {
  return JSON.stringify(plan, null, 2);
}

export function importPlanFromJSON(json: string): Plan | null {
  try {
    const p = JSON.parse(json);
    if (p.id && p.name && Array.isArray(p.tables) && Array.isArray(p.guests) && Array.isArray(p.rules)) {
      return p as Plan;
    }
  } catch {}
  return null;
}
