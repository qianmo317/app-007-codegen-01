export type Guest = {
  id: string;
  name: string;
  tags: string[];
  partySize: number;
  childSeat?: boolean;
  note?: string;
  /** 所属主客 id：随行家属/小孩指向主客，主客自身没有该字段 */
  primaryId?: string;
  /** 随哪一批导入进来的批次 id（手动添加的宾客没有） */
  batchId?: string;
};

export type TableShape = 'round' | 'rect';

export type Table = {
  id: string;
  label: string;
  x: number;
  y: number;
  shape: TableShape;
  capacity: number;
  seatOrder: string[]; // guest ids, length <= capacity
};

export type RuleType = 'together' | 'apart' | 'adjacent' | 'separate';

export type Rule = {
  id: string;
  type: RuleType;
  a: string; // guest id
  b: string; // guest id
};

/** 名单改动记录（导入 / 退回 / 编辑） */
export type ChangeLog = {
  id: string;
  ts: number;
  kind: 'import' | 'rollback' | 'edit';
  summary: string;
  /** 该批新增的宾客 id（导入时可整批退回） */
  batchId?: string;
  guestIds?: string[];
  /** 是否已经被整批退回 */
  rolledBack?: boolean;
};

export type Plan = {
  id: string;
  name: string;
  tables: Table[];
  guests: Guest[];
  rules: Rule[];
  logs?: ChangeLog[];
  updatedAt: number;
};

export type Command =
  | { type: 'updatePlan'; plan: Plan }
  | { type: 'updateTables'; tables: Table[] }
  | { type: 'updateGuests'; guests: Guest[] }
  | { type: 'updateRules'; rules: Rule[] }
  | { type: 'updateTable'; table: Table }
  | { type: 'addGuest'; guest: Guest }
  | { type: 'removeGuest'; guestId: string }
  | { type: 'addTable'; table: Table }
  | { type: 'removeTable'; tableId: string }
  | { type: 'moveGuest'; guestId: string; fromTableId: string | null; toTableId: string | null; toIndex?: number }
  | { type: 'batch'; commands: Command[] };

export const TAG_OPTIONS = ['男方亲属', '女方亲属', '同事', '同学', '儿童', '素食', '家属'];
